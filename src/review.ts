/**
 * Review runner: load (or reopen) a per-PR/per-persona session, append the
 * new diff as a user turn, run the LLM, persist the transcript, and return
 * the review text + usage (with cacheRead surfaced).
 *
 * Persistence shape (one JSONL file per session, shared across runners):
 *   <sessionsRoot>/<pr>/<persona>.jsonl
 * Each line is one AgentMessage (user/assistant/toolResult). On reopen we
 * read the file, replay messages into the model context, and continue.
 *
 * Why JSONL and not a DB: the file is naturally portable across runners and
 * CI machines — commit it as an artifact or mount the dir. No SQLite, no
 * export/import bundle dance. This is the pi advantage over opencode.
 *
 * Cache behavior: DeepSeek does content-addressed prefix caching. When the
 * same system+history prefix is resent (which is exactly what resume does),
 * the upstream returns prompt_tokens_details.cached_tokens, and pi-ai's
 * openai-completions parser writes it into usage.cacheRead. So on the second
 * run for the same (pr, persona), cacheRead should be > 0 and cost lower.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  createModels,
  type AssistantMessage,
  type Provider,
  type Usage,
  type Model,
} from "@earendil-works/pi-ai";

export interface RunReviewOptions {
  provider: Provider<"openai-completions">;
  pr: number;
  persona: string;
  /** The PR diff text (e.g. `git diff`). */
  diff: string;
  /** Root directory for session JSONL files. */
  sessionsRoot: string;
  /** Model id within the provider. Default "deepseek-v4-flash". */
  modelId?: string;
  /** Override the system prompt; default is persona-driven. */
  systemPrompt?: string;
  /** Max output tokens for the review. */
  maxOutputTokens?: number;
}

export interface ReviewResult {
  content: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    costTotal: number;
  };
  resumed: boolean;
  sessionId: string;
}

interface StoredMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

function defaultSystemPrompt(persona: string): string {
  return [
    `You are a senior code reviewer focused on ${persona}.`,
    `Review the diff provided by the user. Be specific: cite file:line,`,
    `classify each finding as blocker / warning / suggestion, and keep prose tight.`,
    `If there are no real issues, say so explicitly — do not invent concerns.`,
  ].join(" ");
}

async function sessionPath(opts: RunReviewOptions): Promise<string> {
  const dir = path.join(opts.sessionsRoot, String(opts.pr));
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, `${opts.persona}.jsonl`);
}

async function loadMessages(file: string): Promise<StoredMessage[]> {
  try {
    const text = await fs.readFile(file, "utf8");
    return text
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as StoredMessage);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function appendMessage(file: string, msg: StoredMessage): Promise<void> {
  await fs.appendFile(file, JSON.stringify(msg) + "\n");
}

function buildContext(
  systemPrompt: string,
  history: StoredMessage[],
  newDiff: string,
): { systemPrompt: string; messages: { role: "user"; content: string; timestamp: number }[] } {
  const messages = history.map((m) => ({
    role: "user" as const,
    // Replay: prior user turns as user, assistant turns as prior context.
    // NB: pi-ai Context.messages is UserMessage-only for inputs; full
    // assistant replay needs Agent (see roadmap). For cache validation this
    // minimal shape suffices because the system prompt + prior user content
    // is the shared prefix that DeepSeek caches.
    content: m.role === "assistant" ? `(previous review)\n${m.content}` : m.content,
    timestamp: m.timestamp,
  }));
  messages.push({
    role: "user",
    content: `Review this diff:\n\n${newDiff}`,
    timestamp: Date.now(),
  });
  return { systemPrompt, messages };
}

export async function runReview(opts: RunReviewOptions): Promise<ReviewResult> {
  const file = await sessionPath(opts);
  const history = await loadMessages(file);
  const resumed = history.length > 0;
  const systemPrompt = opts.systemPrompt ?? defaultSystemPrompt(opts.persona);
  const sessionId = `${opts.pr}-${opts.persona}`;

  const models = createModels();
  models.setProvider(opts.provider);
  const modelId = opts.modelId ?? "deepseek-v4-flash";
  const model = models.getModel(opts.provider.id, modelId);
  if (!model) {
    throw new Error(`model ${modelId} not found in provider ${opts.provider.id}`);
  }

  const ctx = buildContext(systemPrompt, history, opts.diff);
  const stream = models.streamSimple(model, ctx as never, {
    temperature: 0,
    maxOutputTokens: opts.maxOutputTokens ?? 2048,
  } as never);

  let text = "";
  let usage: Usage | null = null;
  let errorMessage: string | null = null;
  for await (const ev of stream as AsyncIterable<{ type: string; text?: string; delta?: string; message?: AssistantMessage; usage?: Usage }>) {
    if (ev.type === "text_delta" || ev.type === "text") text += ev.text ?? ev.delta ?? "";
    else if (ev.type === "usage" && ev.usage) usage = ev.usage;
    else if (ev.type === "done" && ev.message?.usage) usage = ev.message.usage;
    else if (ev.type === "error") {
      errorMessage = ev.message?.errorMessage ?? "unknown stream error";
    }
  }

  if (errorMessage || !usage) {
    throw new Error(`review stream failed: ${errorMessage ?? "no usage returned"}`);
  }

  // Persist this turn (user diff + assistant review).
  const now = Date.now();
  await appendMessage(file, {
    role: "user",
    content: opts.diff,
    timestamp: now,
  });
  await appendMessage(file, {
    role: "assistant",
    content: text,
    timestamp: now + 1,
  });

  return {
    content: text,
    usage: {
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      costTotal: usage.cost.total,
    },
    resumed,
    sessionId,
  };
}

// Re-export types used by callers.
export type { Provider, Model };
