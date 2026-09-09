/**
 * Per-run statistics events: every completed review (single or team) is
 * emitted as ONE append-only JSONL line locally, and optionally POSTed to a
 * central dashboard. The event is the aggregation contract between the agent
 * and any consumer — fields are additive-only; never rename or repurpose.
 *
 * Emission is strictly fail-open: a stats problem (bad path, unreachable
 * dashboard) must never turn a finished review into a failed run. The whole
 * mechanism is opt-in (stats-enabled, default off). When enabled, the local
 * JSONL file is the durable record; PI_REVIEW_STATS_URL additionally ships
 * each event to a central dashboard for cross-repo aggregation.
 *
 * Pure module (no pi-ai imports) so it stays testable under `node --test`,
 * same rationale as collect-review.ts.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export interface StatsPersonaUsage {
  name: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  resumed: boolean;
  error?: string;
}

export interface StatsEvent {
  schema: 1;
  /** ISO 8601 UTC — completion time of the run. */
  ts: string;
  platform: string;
  repository: string;
  pr: number;
  /** CI run identity or a local random id — see resolveRunIdentity. */
  runId: string;
  attempt: number;
  mode: "single" | "team";
  /** Every billed role, coordinator included (it is just another role for
   *  per-persona cost analysis; a flat array keeps consumers simple). */
  personas: StatsPersonaUsage[];
  /** Coordinator verdict (team mode). Null in single mode — a lone reviewer
   *  emits severity only, there is nothing to synthesize. */
  verdict: string | null;
  severity: { decision: string; blocking: number; warning: number; fallback: boolean };
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costTotal: number;
  durationMs: number | null;
}

/** Structural input shaped so index.ts can hand over PersonaReview /
 *  ReviewResult objects without adaptation helpers. */
export interface StatsPersonaInput {
  name: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; costTotal: number };
  resumed: boolean;
  error?: string;
}

export interface BuildStatsEventInput {
  now?: Date;
  platform: string;
  repository: string;
  pr: number;
  runId: string;
  attempt: number;
  mode: "single" | "team";
  personas: StatsPersonaInput[];
  coordinator: StatsPersonaInput | null;
  verdict: string | null;
  severity: StatsEvent["severity"];
  durationMs: number | null;
}

export function buildStatsEvent(input: BuildStatsEventInput): StatsEvent {
  const roles = input.coordinator ? input.personas.concat(input.coordinator) : input.personas;
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let costTotal = 0;
  const personas: StatsPersonaUsage[] = roles.map((r) => {
    usage.input += r.usage.input;
    usage.output += r.usage.output;
    usage.cacheRead += r.usage.cacheRead;
    usage.cacheWrite += r.usage.cacheWrite;
    costTotal += r.usage.costTotal;
    return {
      name: r.name,
      input: r.usage.input,
      output: r.usage.output,
      cacheRead: r.usage.cacheRead,
      cacheWrite: r.usage.cacheWrite,
      cost: r.usage.costTotal,
      resumed: r.resumed,
      error: r.error,
    };
  });
  return {
    schema: 1,
    ts: (input.now ?? new Date()).toISOString(),
    platform: input.platform,
    repository: input.repository,
    pr: input.pr,
    runId: input.runId,
    attempt: input.attempt,
    mode: input.mode,
    personas,
    verdict: input.verdict,
    severity: input.severity,
    usage,
    costTotal,
    durationMs: input.durationMs,
  };
}

/**
 * Identity for dedupe on the dashboard: (platform, repository, runId,
 * attempt) is the UNIQUE key, so an HTTP retry of the same event upserts to
 * one row instead of double-counting. GitHub and Gitea Actions both inject
 * GITHUB_RUN_ID/GITHUB_RUN_ATTEMPT; local runs have neither and get a random
 * id — every local run is a distinct event, which is the desired counting
 * semantics (local retries already dedupe at the runReview layer).
 *
 * CONTRACT LIMITATION: GITHUB_RUN_ID is shared by EVERY job of one workflow
 * run, so this key assumes ONE review event per (repository, run, attempt)
 * — i.e. one action step per workflow (team mode recommended). A workflow
 * that runs several independent review jobs on the same repo/PR (a persona
 * matrix, or single + team together) collapses them into one dashboard row
 * and undercounts. Supporting that needs a per-invocation nonce added to
 * the key — an additive schema change, deliberately out of scope here.
 */
export function resolveRunIdentity(env: NodeJS.ProcessEnv): { runId: string; attempt: number } {
  const runId = env.GITHUB_RUN_ID?.trim();
  if (runId) {
    const attempt = Number(env.GITHUB_RUN_ATTEMPT);
    return { runId, attempt: Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 1 };
  }
  return { runId: `local-${randomUUID().slice(0, 8)}`, attempt: 1 };
}

/** Serialize one event as a JSONL line for the LOCAL stats.jsonl file. "<"
 *  is escaped so a naive consumer that embeds the RAW line into an HTML
 *  script context (e.g. cat stats.jsonl into a <script> block) cannot have
 *  the line terminated early. This does NOT protect the dashboard: the
 *  shipped POST body is plain JSON.stringify (escaping it there would be
 *  pointless — any JSON parser restores "<"), and real protection is output
 *  escaping in the dashboard's own renderer. */
export function statsEventLine(event: StatsEvent): string {
  return `${JSON.stringify(event).replace(/</g, "\\u003c")}\n`;
}

export function appendStatsEvent(file: string, event: StatsEvent): void {
  // Defensive mkdir: local runs may reach stats.jsonl before any review
  // session created <sessions-root> (sessionFile mkdirs it lazily) — the
  // local record must not depend on that ordering.
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, statsEventLine(event), "utf8");
}

/** POST events to the dashboard ingest endpoint. Fail-open: returns false
 *  instead of throwing so a stats hiccup never fails a review run. */
export async function shipStatsEvents(
  url: string,
  token: string | undefined,
  events: StatsEvent[],
): Promise<boolean> {
  if (!url || events.length === 0) return false;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      // A dashboard sits one intranet hop away; 5s is generous, and the cap
      // keeps a wedged endpoint from stalling the end of a CI run.
      body: JSON.stringify(events.length === 1 ? events[0] : events),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface RecordStatsOptions {
  /** Local JSONL path (typically <sessionsRoot>/stats.jsonl). Undefined
   *  skips the local append. */
  file?: string;
  /** Dashboard ingest URL (PI_REVIEW_STATS_URL). Undefined skips shipping. */
  url?: string;
  token?: string;
  event: StatsEvent;
}

/**
 * The single emission point wired into index.ts: append locally, then ship.
 * Both legs fail-open — stats must never change a review's exit status —
 * and outcomes surface on stderr so a silent dashboard misconfig is
 * debuggable from the CI log.
 */
export async function recordStats(opts: RecordStatsOptions): Promise<void> {
  if (opts.file) {
    try {
      appendStatsEvent(opts.file, opts.event);
    } catch (err: unknown) {
      process.stderr.write(
        `stats: local append failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
  if (opts.url) {
    const shipped = await shipStatsEvents(opts.url, opts.token, [opts.event]);
    if (!shipped) {
      process.stderr.write(`stats: dashboard push failed (${opts.url})\n`);
    }
  }
}
