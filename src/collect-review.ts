/**
 * Collect a review result from a pi-agent-core Agent's event stream.
 *
 * Split out of review.ts (which imports the pi-agent-core runtime as a
 * value) so the collection semantics are unit-testable under node --test —
 * same rationale as team-comment.ts. All pi-agent-core/pi-ai imports here
 * are type-only and erased at runtime.
 */
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";

/**
 * Upstream error captured from the terminal assistant message. pi-agent-core
 * ends a failed run by emitting a synthetic assistant message with empty
 * text, EMPTY_USAGE, and stopReason="error" + errorMessage=<real cause>
 * (agent-loop.js returns on stopReason error/aborted; Agent.handleRunFailure
 * synthesizes the same shape for thrown stream errors).
 *
 * The caller MUST treat a present errorMessage as a failed attempt: the
 * `content`/`usage` fields then hold stale values from an earlier turn, not
 * a finished review (#59 — four personas "succeeded" with pre-tool-call
 * thinking fragments because the empty synthetic usage didn't overwrite the
 * previous turn's usage, so the no-usage guard never fired).
 */
export interface CollectedReview {
  content: string;
  usage: ReviewUsage | null;
  errorMessage?: string;
}

export interface ReviewUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costTotal: number;
}

interface TextBlock {
  type: "text";
  text: string;
}

function isTextBlock(c: unknown): c is TextBlock {
  return typeof c === "object" && c !== null && "type" in c && c.type === "text";
}

/** Minimal Agent surface collectFromAgent depends on (tests fake this). */
export interface AgentLike {
  subscribe(listener: (ev: AgentEvent) => void): unknown;
}

/**
 * Wire an Agent's event stream to a promise that resolves on agent_end.
 *
 * Transcript bookkeeping listens ONLY to message_end: turn_end re-carries the
 * same assistant message (types.d.ts gives both a `message` field), so
 * handling both used to push every assistant message twice into the JSONL
 * session transcript — duplicated turns on every resume.
 */
export function collectFromAgent(
  agent: AgentLike,
  newMessages: AgentMessage[],
): Promise<CollectedReview> {
  const { promise, resolve } = Promise.withResolvers<CollectedReview>();
  let lastAssistantText = "";
  let lastUsage: Usage | null = null;
  let lastErrorMessage: string | undefined;

  agent.subscribe((ev: AgentEvent) => {
    if (ev.type === "agent_end") {
      resolve({
        content: lastAssistantText,
        usage: lastUsage
          ? {
              input: lastUsage.input,
              output: lastUsage.output,
              cacheRead: lastUsage.cacheRead,
              cacheWrite: lastUsage.cacheWrite,
              costTotal: lastUsage.cost.total,
            }
          : null,
        errorMessage: lastErrorMessage,
      });
      return;
    }
    if (ev.type !== "message_end") return;
    const msg = ev.message as AssistantMessage | undefined;
    if (!msg) return;
    newMessages.push(ev.message);
    if (msg.role !== "assistant") return;
    const text = msg.content.filter(isTextBlock).map((c) => c.text).join("");
    if (text) lastAssistantText = text;
    if (msg.usage && (msg.usage.input || msg.usage.output || msg.usage.cacheRead)) {
      lastUsage = msg.usage;
    }
    // A terminal error/aborted stopReason marks the whole run as failed.
    // The synthetic message reports the real cause in errorMessage; keep a
    // stopReason-derived fallback in case a provider omits the field.
    if ("errorMessage" in msg && typeof msg.errorMessage === "string" && msg.errorMessage) {
      lastErrorMessage = msg.errorMessage;
    } else if (msg.stopReason === "error" || msg.stopReason === "aborted") {
      lastErrorMessage = `stream ${msg.stopReason}`;
    }
  });

  return promise;
}
