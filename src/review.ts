/**
 * Review runner built on @earendil-works/pi-agent-core's Agent.
 *
 * Resume contract:
 *   On the first call for (pr, persona) we create an Agent and prompt it with
 *   the diff. The full transcript (user + assistant + tool messages) is
 *   persisted to <sessionsRoot>/<pr>/<persona>.jsonl.
 *   On subsequent calls we deserialize the transcript, seed the Agent with it,
 *   then prompt with the new diff. DeepSeek does content-addressed prefix
 *   caching, so the replayed prefix hits the cache: usage.cacheRead > 0 and
 *   the discounted cost applies. pi-ai surfaces cacheRead (opencode's
 *   openai-compatible path drops it to 0).
 *
 * Tools:
 *   read + grep, scoped to cwd (the action wrapper sets cwd to the checked-out
 *   repo). The reviewer can pull surrounding source to ground its findings.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { Agent, type AgentEvent, type AgentMessage } from "@earendil-works/pi-agent-core";
import {
  createModels,
  type Api,
  type AssistantMessage,
  type Model,
  type Provider,
  type Usage,
} from "@earendil-works/pi-ai";
import { createReadFileTool, createGrepTool, type GrepWalker } from "./tools.js";
import { walkGrep } from "./walk-grep.js";
import { isTransientReviewerError } from "./transient-error.js";

export interface RunReviewOptions {
  provider: Provider<"openai-completions">;
  pr: number;
  persona: string;
  diff: string;
  /**
   * Pre-formatted PR context block (title, body, comments, reviews). When
   * set, prepended to the diff in the user prompt so the reviewer sees why
   * the PR exists and what humans/bots already said. Empty/undefined →
   * diff-only (legacy behavior). Best-effort: callers should obtain this
   * via fetchPrContext which never throws. */
  prContext?: string;
  /**
   * Pre-formatted related-files context block (files that import the changed
   * files — reverse edges). When set, prepended to the diff so the reviewer
   * sees the blast radius of the change without having to grep for callers.
   * Empty/undefined → no related context. Best-effort like prContext. */
  relatedContext?: string;
  /** Root directory for session JSONL files. */
  sessionsRoot: string;
  /** Reviewer cwd for read/grep tools. Default process.cwd(). */
  cwd?: string;
  modelId?: string;
  /**
   * Fallback model ids to try when the primary model fails permanently
   * (non-transient). Tried in order; the first successful result wins.
   * Each fallback gets its own fresh retry loop (maxAttempts × backoff).
   * Example: ["gpt-4o", "mimo-v2.5"].
   */
  fallbackModels?: string[];
  systemPrompt?: string;
  /**
   * Output language for the review prose (summary, findings, suggestions).
   * Accepts short codes (zh, en, ja, ...) or full names (中文, English).
   * Default undefined = English (no directive appended). The verdict
   * keywords (CAN MERGE / CONDITIONAL MERGE / CANNOT MERGE) always stay
   * English uppercase — they are parsed by machine.
   */
  language?: string;
  /**
   * Per-review hard timeout in ms. On expiry the attempt fails and, if the
   * error is transient, retries. Default 600_000 (10 min). Set to 0 to
   * disable (not recommended — a wedged stream would hang the whole batch).
   */
  timeoutMs?: number;
  /** Max attempts per review. Default 3. A transient upstream blip triggers
   *  a fresh-session retry with exponential backoff + jitter. */
  maxAttempts?: number;
  /** Base (ms) for exponential backoff between retries. Default 1000.
   *  Backoff = base * 2^(attempt-1) + jitter[0, base]. */
  retryBackoffMs?: number;
  /** Inject a custom grep walker (tests). Defaults to the file-system walker. */
  grepWalker?: GrepWalker;
}

export interface ReviewUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costTotal: number;
}

export interface ReviewResult {
  content: string;
  usage: ReviewUsage;
  resumed: boolean;
  sessionId: string;
  /** Messages appended this turn (the new user prompt + assistant reply + tool traffic). */
  newMessages: AgentMessage[];
}

function defaultSystemPrompt(persona: string): string {
  const padded =
    "You are a senior code reviewer. Cite file:line for each finding, " +
    "classify as blocker / warning / suggestion, and prefer specific concrete " +
    "remedies over generic advice. Do not invent issues if the diff is fine. " +
    "Focus on correctness, then security, then clarity, in that order. ".repeat(40);
  return padded + `\n\nReviewer persona: ${persona}.`;
}
// Short codes → display names. Unknown values pass through unchanged so
// users can pass full language names directly (e.g. "中文", "Português").
const LANGUAGE_ALIASES: Record<string, string> = {
  zh: "中文",
  cn: "中文",
  "zh-cn": "中文",
  "zh-tw": "繁體中文",
  en: "English",
  ja: "日本語",
  jp: "日本語",
  ko: "한국어",
  fr: "Français",
  de: "Deutsch",
  es: "Español",
  ru: "Русский",
};

function resolveLanguageName(lang: string): string {
  const key = lang.trim().toLowerCase();
  return LANGUAGE_ALIASES[key] ?? lang.trim();
}

/**
 * Append a language directive to a system prompt. No-op for English (the
 * prompts' native language) or when language is unset, so existing callers
 * keep their behavior. The verdict keywords are exempt from translation —
 * extractVerdict / resolveVerdict match them by machine.
 */
function appendLanguageDirective(base: string, lang: string | undefined): string {
  if (!lang) return base;
  const name = resolveLanguageName(lang);
  if (name === "English") return base;
  return (
    base +
    `\n\nWrite the summary, findings, and all prose in ${name}. ` +
    `The verdict keywords (CAN MERGE / CONDITIONAL MERGE / CANNOT MERGE) ` +
    `MUST stay in English uppercase on the first line — they are parsed by ` +
    `machine and must never be translated.`
  );
}

async function sessionFile(opts: RunReviewOptions): Promise<string> {
  const dir = path.join(opts.sessionsRoot, String(opts.pr));
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, `${opts.persona}.jsonl`);
}

async function loadTranscript(file: string): Promise<AgentMessage[]> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: AgentMessage[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    out.push(JSON.parse(line) as AgentMessage);
  }
  return out;
}

async function appendTranscript(file: string, messages: AgentMessage[]): Promise<void> {
  const block = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
  await fs.appendFile(file, block);
}

interface CollectedReview {
  content: string;
  usage: ReviewUsage | null;
  /**
   * Upstream error captured from pi-agent-core's failureMessage. When the
   * stream errors, the loop emits a synthetic assistant message with empty
   * usage and stopReason="error" + errorMessage=<real cause>. Without
   * capturing this the real error is swallowed and the caller only sees
   * "no usage" — useless for diagnosing transient vs permanent failures.
   */
  errorMessage?: string;
}

interface TextBlock {
  type: "text";
  text: string;
}

function isTextBlock(c: unknown): c is TextBlock {
  return typeof c === "object" && c !== null && "type" in c && c.type === "text";
}

/** Wire an Agent's event stream to a promise that resolves on agent_end. */
function collectFromAgent(agent: Agent, newMessages: AgentMessage[]): Promise<CollectedReview> {
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
    if (ev.type !== "message_end" && ev.type !== "turn_end") return;
    const msg = ev.message as AssistantMessage | undefined;
    if (!msg) return;
    newMessages.push(ev.message);
    if (msg.role !== "assistant") return;
    const text = msg.content.filter(isTextBlock).map((c) => c.text).join("");
    if (text) lastAssistantText = text;
    if (msg.usage && (msg.usage.input || msg.usage.output || msg.usage.cacheRead)) {
      lastUsage = msg.usage;
    }
    // pi-agent-core's handleRunFailure emits a synthetic assistant message
    // with empty usage, stopReason="error", and the real cause in errorMessage.
    if ("errorMessage" in msg && typeof msg.errorMessage === "string") {
      lastErrorMessage = msg.errorMessage;
    }
  });

  return promise;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  const { promise: timeout, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => reject(new Error(`${label} timed out after ${ms}ms`)),
    ms,
  );
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}


/**
 * Run a single model attempt with retry loop. Returns the result or throws
 * on permanent failure (after exhausting retries for transient errors).
 */
async function runModelAttempt(
  opts: RunReviewOptions,
  modelId: string,
  file: string,
  transcript: AgentMessage[],
  resumed: boolean,
  systemPrompt: string,
  sessionId: string,
  cwd: string,
): Promise<ReviewResult> {
  const models = createModels();
  models.setProvider(opts.provider);
  const model = models.getModel(opts.provider.id, modelId);
  if (!model) {
    throw new Error(`model ${modelId} not found in provider ${opts.provider.id}`);
  }
  const tools = [createReadFileTool(cwd), createGrepTool(cwd, opts.grepWalker ?? walkGrep)];
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const maxAttempts = opts.maxAttempts ?? 3;
  const backoffBase = opts.retryBackoffMs ?? 1000;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const newMessages: AgentMessage[] = [];
      const agent = new Agent({
        initialState: {
          systemPrompt,
          model: model as Model<Api>,
          thinkingLevel: "off",
          tools,
          messages: transcript,
        },
        sessionId,
        streamFn: async (m, ctx, streamOpts) =>
          models.streamSimple(m, ctx, streamOpts ?? {}) as never,
      });
      const done = collectFromAgent(agent, newMessages);
      // Assemble the prompt prefix (PR metadata + related files), keeping the
      // diff last so the "Review this diff" instruction sits right above it.
      // Empty/undefined blocks are skipped so a diff-only run is unchanged.
      const prefix = [opts.prContext, opts.relatedContext].filter((s): s is string => Boolean(s && s.trim())).join("\n\n");
      const userMessage = prefix
        ? `${prefix}\n\n=== Review request ===\nReview this diff:\n\n${opts.diff}`
        : `Review this diff:\n\n${opts.diff}`;
      const promptP = agent.prompt(userMessage);
      await (timeoutMs > 0 ? withTimeout(promptP, timeoutMs, opts.persona) : promptP);
      const collected = await done;
      if (!collected.usage) {
        const cause = collected.errorMessage ?? "no usage returned";
        throw new Error(`review completed with no usage — ${cause}`);
      }
      await appendTranscript(file, newMessages);
      return {
        content: collected.content,
        usage: collected.usage,
        resumed,
        sessionId,
        newMessages,
      };
    } catch (err) {
      lastError = err;
      const transient = isTransientReviewerError(err);
      if (attempt >= maxAttempts || !transient) throw err;
      const backoff = backoffBase * 2 ** (attempt - 1) + Math.floor(Math.random() * backoffBase);
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[${opts.persona}] attempt ${attempt}/${maxAttempts} failed (${msg}), retrying in ${backoff}ms\n`,
      );
      await sleep(backoff);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`review failed for ${opts.persona} without a captured error`);
}

export async function runReview(opts: RunReviewOptions): Promise<ReviewResult> {
  const file = await sessionFile(opts);
  const transcript = await loadTranscript(file);
  const resumed = transcript.length > 0;
  const systemPrompt = appendLanguageDirective(
    opts.systemPrompt ?? defaultSystemPrompt(opts.persona),
    opts.language,
  );
  const sessionId = `${opts.pr}-${opts.persona}`;
  const cwd = opts.cwd ?? process.cwd();
  const primaryModel = opts.modelId ?? "deepseek-v4-flash";
  const fallbackModels = opts.fallbackModels ?? [];

  // Try primary model first, then fallbacks in order. runModelAttempt already
  // retries transient errors internally (maxAttempts × backoff); if it throws,
  // retries are exhausted and we should try the next model regardless of error
  // type — the fallback model may route through a different upstream endpoint.
  const allModels = [primaryModel, ...fallbackModels];
  const errors: string[] = [];
  for (const modelId of allModels) {
    try {
      process.stderr.write(`[${opts.persona}] trying model: ${modelId}\n`);
      return await runModelAttempt(opts, modelId, file, transcript, resumed, systemPrompt, sessionId, cwd);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${modelId}: ${msg}`);
      if (modelId !== allModels[allModels.length - 1]) {
        process.stderr.write(
          `[${opts.persona}] model ${modelId} failed (${msg}), trying next fallback\n`,
        );
      }
    }
  }
  throw new Error(`all models failed for ${opts.persona}:\n${errors.join("\n")}`);
}
