/**
 * Production LLM verifier: builds an `LLMVerifyFn` backed by a real
 * pi-agent-core Agent (read + grep tools), the same runtime the reviewers use.
 *
 * Kept separate from verifier.ts so the pure logic (verifyInlineComments +
 * rule layer) stays unit-testable without the pi-agent-core dependency that
 * can't be resolved under `node --test` (per the note in team-comment.ts).
 *
 * Mirrors the Agent construction in review.ts (createModels → setProvider →
 * getModel → tools → new Agent → collectFromAgent → agent.prompt → await),
 * but per-finding: each call spawns one short agent turn that reads around the
 * cited line and greps for the symbol the finding names, then returns a JSON
 * verdict. No session persistence — verification is a one-shot, stateless
 * check (unlike reviews, which resume across pushes).
 */
import { Agent, type AgentEvent, type AgentMessage } from "@earendil-works/pi-agent-core";
import {
  createModels,
  type Api,
  type AssistantMessage,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import { createReadFileTool, createGrepTool } from "./tools.js";
import { walkGrep } from "./walk-grep.js";
import type { InlineComment } from "./inline-comments.js";
import type { LLMVerifyFn, LLMVerdict, VerifyOptions } from "./verifier.js";

const VERIFIER_SYSTEM = [
  "You are a verification agent. A code reviewer reported a finding pinned to a",
  "specific file and line. Your ONLY job: confirm whether the finding's description",
  "matches the actual code at that location. You do NOT review for new issues — you",
  "check ONE existing claim.",
  "",
  "Use the `read` tool to read the cited file around the cited line, and the `grep`",
  "tool to locate any symbol/identifier the finding names. Then judge:",
  "- Does the cited line contain what the finding says it contains?",
  "- If the finding names a symbol (function/type/variable), does that symbol exist",
  "  where the finding implies?",
  "",
  "Be skeptical but precise. A finding is wrong only if the code clearly contradicts",
  "it; a vague finding that could plausibly apply is `uphold` (the human still reads it).",
  "",
  "Respond with ONLY a JSON object, no prose:",
  '  {"verdict":"uphold","reason":"code matches the claim"}',
  '  {"verdict":"demote","reason":"cited line is a getter, no deleteUser call"}',
].join("\n");

interface TextBlock {
  type: "text";
  text: string;
}
function isTextBlock(c: unknown): c is TextBlock {
  return typeof c === "object" && c !== null && "type" in c && c.type === "text";
}

/** Collect the assistant's final text from an agent's event stream. */
function collectText(agent: Agent): Promise<string> {
  const { promise, resolve } = Promise.withResolvers<string>();
  let last = "";
  agent.subscribe((ev: AgentEvent) => {
    if (ev.type === "agent_end") {
      resolve(last);
      return;
    }
    if (ev.type !== "message_end" && ev.type !== "turn_end") return;
    const msg = ev.message as AssistantMessage | undefined;
    if (!msg || msg.role !== "assistant") return;
    const text = msg.content.filter(isTextBlock).map((c) => c.text).join("");
    if (text) last = text;
  });
  return promise;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const { promise: timeout, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => reject(new Error(`verifier timed out after ${ms}ms`)), ms);
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Extract the JSON verdict object from the agent's (possibly fenced/chatty) text. */
function parseVerdict(text: string): LLMVerdict | null {
  // Try to find a {...} block. The model may wrap it in ```json fences or add
  // stray prose; find the first balanced object.
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === "\\" && inString) {
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try {
          const obj = JSON.parse(candidate) as { verdict?: unknown; reason?: unknown };
          if (obj.verdict === "uphold" || obj.verdict === "demote") {
            return {
              verdict: obj.verdict,
              reason: typeof obj.reason === "string" ? obj.reason : "",
            };
          }
          return null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Build a production LLM verifier from provider wiring. Returns an `LLMVerifyFn`
 * suitable to pass as `opts.llmVerify` to verifyInlineComments.
 */
export function buildVerifierAgent(provider: Provider<"openai-completions">, opts: {
  cwd: string;
  modelId?: string;
  grepWalker?: VerifyOptions["grepWalker"];
}): LLMVerifyFn {
  // Models are set up once; the per-finding loop reuses them across calls.
  const models = createModels();
  models.setProvider(provider);
  const modelId = opts.modelId ?? "deepseek-v4-flash";
  const model = models.getModel(provider.id, modelId);
  if (!model) {
    throw new Error(`verifier: model ${modelId} not found in provider ${provider.id}`);
  }
  const tools = [createReadFileTool(opts.cwd), createGrepTool(opts.cwd, opts.grepWalker ?? walkGrep)];

  return async (comment: InlineComment): Promise<LLMVerdict | null> => {
    const prompt = [
      `Finding to verify: ${comment.file}:${comment.line} (${comment.side} side)`,
      `Severity: ${comment.severity}`,
      `Claim: ${comment.body}`,
      "",
      "Read the cited location and grep for any symbol the claim names, then return the JSON verdict.",
    ].join("\n");

    try {
      const newMessages: AgentMessage[] = [];
      const agent = new Agent({
        initialState: {
          systemPrompt: VERIFIER_SYSTEM,
          model: model as Model<Api>,
          thinkingLevel: "off",
          tools,
          messages: [],
        },
        sessionId: `verifier-${comment.file}:${comment.line}`,
        streamFn: async (m, ctx, streamOpts) =>
          models.streamSimple(m, ctx, streamOpts ?? {}) as never,
      });
      const done = collectText(agent);
      const promptP = agent.prompt(prompt);
      // Verifier turns are short; cap well under the 10-min review budget.
      await withTimeout(promptP, 120_000);
      const text = await done;
      return parseVerdict(text);
    } catch {
      // Any failure → null → caller stays verified (fail-open).
      return null;
    }
  };
}
