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

export interface RunReviewOptions {
  provider: Provider<"openai-completions">;
  pr: number;
  persona: string;
  diff: string;
  /** Root directory for session JSONL files. */
  sessionsRoot: string;
  /** Reviewer cwd for read/grep tools. Default process.cwd(). */
  cwd?: string;
  modelId?: string;
  systemPrompt?: string;
  /**
   * Output language for the review prose (summary, findings, suggestions).
   * Accepts short codes (zh, en, ja, ...) or full names (中文, English).
   * Default undefined = English (no directive appended). The verdict
   * keywords (CAN MERGE / CONDITIONAL MERGE / CANNOT MERGE) always stay
   * English uppercase — they are parsed by machine.
   */
  language?: string;
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
}

interface TextBlock {
  type: "text";
  text: string;
}

function isTextBlock(c: unknown): c is TextBlock {
  return typeof c === "object" && c !== null && (c as { type?: unknown }).type === "text";
}

/** Wire an Agent's event stream to a promise that resolves on agent_end. */
function collectFromAgent(agent: Agent, newMessages: AgentMessage[]): Promise<CollectedReview> {
  const { promise, resolve } = Promise.withResolvers<CollectedReview>();
  let lastAssistantText = "";
  let lastUsage: Usage | null = null;

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
  });

  return promise;
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

  const models = createModels();
  models.setProvider(opts.provider);
  const modelId = opts.modelId ?? "deepseek-v4-flash";
  const model = models.getModel(opts.provider.id, modelId);
  if (!model) {
    throw new Error(`model ${modelId} not found in provider ${opts.provider.id}`);
  }

  const tools = [createReadFileTool(cwd), createGrepTool(cwd, opts.grepWalker ?? walkGrep)];

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

  const newMessages: AgentMessage[] = [];
  const done = collectFromAgent(agent, newMessages);

  await agent.prompt(`Review this diff:\n\n${opts.diff}`);
  const collected = await done;

  if (!collected.usage) {
    throw new Error("review completed with no usage — stream likely errored");
  }

  await appendTranscript(file, newMessages);

  return {
    content: collected.content,
    usage: collected.usage,
    resumed,
    sessionId,
    newMessages,
  };
}
