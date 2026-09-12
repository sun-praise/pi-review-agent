/**
 * Structured JSON payload for machine consumers (benchmarks, harnesses).
 *
 * `--format json` replaces the human-readable stdout report with a single
 * JSON object (stdout, or a file via --output). The payload carries the same
 * data the PR-comment layer consumes — verified line-pinned findings, the
 * verifier summary, verdict/severity — plus per-persona usage (tokens,
 * cacheRead, cost) so offline analysis can compute cost-per-finding without
 * re-running anything.
 *
 * Field naming note for benchmark adapters: aacr-bench-style harnesses map
 * their reviewer's semantic text field (OCR: `content`, Claude:
 * `summary + failure_scenario`) onto the reference `text`. Ours is `body`.
 *
 * Pure: no fs, no env, no side effects. index.ts owns the write.
 */
import type { ReviewResult, ReviewUsage } from "./review.js";
import type { TeamReviewResult, PersonaReview } from "./orchestrate.js";
import type { InlineComment } from "./inline-comments.js";
import type { VerifySummary } from "./verifier.js";
import type { Severity } from "./severity.js";

export interface JsonPersonaReport {
  persona: string;
  resumed: boolean;
  usage: ReviewUsage;
  /** Set when this reviewer failed (retries exhausted / timeout). */
  error?: string;
}

export interface JsonRunResult {
  mode: "single" | "team";
  pr: number;
  /** Session directory name actually used (set when --session-key given). */
  sessionKey?: string;
  /** Team mode only. */
  verdict?: TeamReviewResult["verdict"];
  severity: Severity;
  /** Verified, line-pinned findings. Empty in single mode (coordinator-only
   *  feature — a lone reviewer emits prose, not structured comments). */
  comments: InlineComment[];
  /** Present when the verifier ran on non-empty findings. */
  verification?: VerifySummary;
  /** True when every blocking finding was demoted by the verifier (team). */
  blockingAllDemoted?: boolean;
  /** Single mode only: the full review prose. */
  content?: string;
  /** Per-reviewer usage; team mode adds the coordinator as `coordinator`. */
  personas: JsonPersonaReport[];
  /** Team mode only: coordinator usage summary (null when skipped/failed). */
  coordinator?: { resumed: boolean; usage: ReviewUsage } | null;
  /** Aggregate over all reviewers (+ coordinator in team mode). */
  usage: ReviewUsage;
}

function sumUsage(results: ReviewResult[]): ReviewUsage {
  const total: ReviewUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costTotal: 0 };
  for (const r of results) {
    total.input += r.usage.input;
    total.output += r.usage.output;
    total.cacheRead += r.usage.cacheRead;
    total.cacheWrite += r.usage.cacheWrite;
    total.costTotal += r.usage.costTotal;
  }
  return total;
}

function personaReport(r: PersonaReview): JsonPersonaReport {
  const report: JsonPersonaReport = {
    persona: r.persona,
    resumed: r.result.resumed,
    usage: r.result.usage,
  };
  if (r.error !== undefined) report.error = r.error;
  return report;
}

export function buildSingleJsonResult(args: {
  pr: number;
  sessionKey?: string;
  persona: string;
  result: ReviewResult;
  severity: Severity;
}): JsonRunResult {
  const { result } = args;
  return {
    mode: "single",
    pr: args.pr,
    sessionKey: args.sessionKey,
    severity: args.severity,
    comments: [],
    content: result.content,
    personas: [
      { persona: args.persona, resumed: result.resumed, usage: result.usage },
    ],
    usage: sumUsage([result]),
  };
}

export function buildTeamJsonResult(args: {
  pr: number;
  sessionKey?: string;
  result: TeamReviewResult;
}): JsonRunResult {
  const { result } = args;
  const all: ReviewResult[] = result.personas.map((p) => p.result);
  if (result.coordinator) all.push(result.coordinator);
  const payload: JsonRunResult = {
    mode: "team",
    pr: args.pr,
    sessionKey: args.sessionKey,
    verdict: result.verdict,
    severity: result.severity,
    comments: result.inlineComments,
    personas: result.personas.map(personaReport),
    coordinator: result.coordinator
      ? { resumed: result.coordinator.resumed, usage: result.coordinator.usage }
      : null,
    usage: sumUsage(all),
  };
  if (result.verification !== undefined) payload.verification = result.verification;
  if (result.blockingAllDemoted !== undefined) {
    payload.blockingAllDemoted = result.blockingAllDemoted;
  }
  return payload;
}
