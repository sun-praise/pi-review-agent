import assert from "node:assert/strict";
import test from "node:test";

import { collectFromAgent, type AgentLike } from "./collect-review.js";
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai";

function usage(partial: Partial<Usage> = {}): Usage {
  return {
    input: 100,
    output: 50,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 150,
    cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
    ...partial,
  };
}

function assistant(partial: Partial<AssistantMessage>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "litellm",
    model: "test-model",
    usage: usage(),
    stopReason: "stop",
    timestamp: 0,
    ...partial,
  };
}

/** The synthetic failure message pi-agent-core emits on a dead stream
 *  (Agent.handleRunFailure): empty text, EMPTY_USAGE, stopReason="error". */
function failureMessage(errorMessage?: string, stopReason: "error" | "aborted" = "error"): AssistantMessage {
  return assistant({
    content: [{ type: "text", text: "" }],
    usage: usage({ input: 0, output: 0, cacheRead: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }),
    stopReason,
    errorMessage,
  });
}

function toolResult(): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "read_file",
    content: [{ type: "text", text: "file body" }],
    isError: false,
    timestamp: 0,
  };
}

/**
 * Fake agent replaying a canned event sequence synchronously. Mirrors the
 * real loop's emission order: message_end per message, turn_end AFTER the
 * tool results re-carrying the same assistant message.
 */
function replayAgent(events: AgentEvent[]): AgentLike {
  return {
    subscribe(listener: (ev: AgentEvent) => void) {
      for (const ev of events) listener(ev);
      return () => {};
    },
  };
}

test("collectFromAgent", async (t) => {
  await t.test("captures the last assistant text and mapped usage", async () => {
    const events: AgentEvent[] = [
      { type: "message_end", message: assistant({ content: [{ type: "text", text: "Let me check a few more areas." }] }) },
      { type: "message_end", message: toolResult() },
      { type: "turn_end", message: assistant({ content: [{ type: "text", text: "Let me check a few more areas." }] }), toolResults: [toolResult()] },
      { type: "message_end", message: assistant({ content: [{ type: "text", text: "CAN MERGE\nfinal review body" }], usage: usage({ input: 200, cacheRead: 64 }) }) },
      { type: "agent_end", messages: [] },
    ];
    const newMessages: AgentMessage[] = [];
    const collected = await collectFromAgent(replayAgent(events), newMessages);
    assert.equal(collected.content, "CAN MERGE\nfinal review body");
    assert.equal(collected.usage?.input, 200);
    assert.equal(collected.usage?.cacheRead, 64);
    assert.equal(collected.usage?.costTotal, 0.003);
    assert.equal(collected.errorMessage, undefined);
  });

  await t.test("flags a terminal stream error even with stale fragment + usage (#59)", async () => {
    // The exact shape of the reported bug: a tool-call turn completes with a
    // pre-tool fragment and real usage, then the stream dies. The synthetic
    // failure message contributes neither text nor usage, so both fields stay
    // stale — only errorMessage reveals the failure.
    const fragment = assistant({ content: [{ type: "text", text: "Let me check one more thing about the SQL construction." }] });
    const events: AgentEvent[] = [
      { type: "message_end", message: fragment },
      { type: "message_end", message: toolResult() },
      { type: "turn_end", message: fragment, toolResults: [toolResult()] },
      { type: "message_end", message: failureMessage("fetch failed") },
      { type: "agent_end", messages: [] },
    ];
    const newMessages: AgentMessage[] = [];
    const collected = await collectFromAgent(replayAgent(events), newMessages);
    // The caller (runModelAttempt) rejects on errorMessage; content/usage are
    // stale and must not be trusted as a finished review.
    assert.equal(collected.errorMessage, "fetch failed");
    assert.equal(collected.content, "Let me check one more thing about the SQL construction.");
    assert.equal(collected.usage?.input, 100);
  });

  await t.test("derives an errorMessage when the provider omits the field", async () => {
    const events: AgentEvent[] = [
      { type: "message_end", message: failureMessage(undefined, "aborted") },
      { type: "agent_end", messages: [] },
    ];
    const collected = await collectFromAgent(replayAgent(events), []);
    assert.equal(collected.errorMessage, "stream aborted");
    assert.equal(collected.usage, null);
  });

  await t.test("pushes each message exactly once despite turn_end re-carrying it", async () => {
    // Regression: the old collector handled both message_end and turn_end,
    // duplicating every assistant message in the persisted JSONL transcript.
    const final = assistant({ content: [{ type: "text", text: "CAN MERGE" }] });
    const events: AgentEvent[] = [
      { type: "message_end", message: final },
      { type: "message_end", message: toolResult() },
      { type: "turn_end", message: final, toolResults: [toolResult()] },
      { type: "agent_end", messages: [] },
    ];
    const newMessages: AgentMessage[] = [];
    await collectFromAgent(replayAgent(events), newMessages);
    assert.equal(newMessages.length, 2);
    assert.equal(newMessages[0], final);
    assert.equal(newMessages[1].role, "toolResult");
  });
});
