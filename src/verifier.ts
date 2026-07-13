/**
 * Verifier: a two-layer check that suppresses hallucinated inline findings
 * before they reach the PR.
 *
 * Layer 1 — rule layer (pure, always runs): for each finding's `{file, line,
 * side}`, confirm the file exists and the line falls inside the diff's changed
 * set for that side. A finding pinned to a line the PR didn't touch is a
 * hallucination or a stale line number → demoted.
 *
 * Layer 2 — LLM layer (optional, injectable): for findings that pass layer 1,
 * ask a read+grep agent whether the finding's *body description* matches the
 * code at that location (e.g. "calls deleteUser()" — does it?). A body that
 * contradicts the code → demoted.
 *
 * Fail-open contract: any uncertainty keeps a finding `verified`. Demotion is
 * reserved for a *positive* judgment that the finding is wrong. This is the
 * opposite polarity from orchestrate.ts's fail-closed reviewer gate, because
 * here false-negatives (dropping a real finding) cost more than false-positives
 * (letting a shaky one through) — the human still reads every inline comment.
 *
 * The LLM layer is injected via `LLMVerifyFn` so tests don't need the
 * pi-agent-core runtime (mirrors how review.ts injects `grepWalker`).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { InlineComment } from "./inline-comments.js";
import type { ChangedLines } from "./changed-lines.js";

/** Outcome of verifying one finding. */
export type VerifyStatus = "verified" | "demoted";

/** A finding annotated with its verification status. */
export interface VerifiedComment extends InlineComment {
  status: VerifyStatus;
  /** Present (and required) when status === "demoted"; explains why. */
  demoteReason?: string;
}

/** Roll-up of a verification pass, surfaced in the PR comment. */
export interface VerifySummary {
  total: number;
  verified: number;
  demoted: number;
  /** Demoted findings, with reasons — rendered in a collapsible section. */
  demotedList: VerifiedComment[];
}

export interface VerifyOptions {
  /** Repo checkout root — used to check file existence and to scope read/grep. */
  cwd: string;
  /** Changed-line sets per file, from parseChangedLines(diff). */
  changedLines: Map<string, ChangedLines>;
  /** Skip the LLM layer; run rule layer only. Default false (run both). */
  skipLlm?: boolean;
  /** Injected LLM verify function. Production wires the real agent-based one
   *  (buildVerifierAgent); tests inject a stub. Undefined + skipLlm false →
   *  build the real one from the provider/options below. */
  llmVerify?: LLMVerifyFn;
  /** Provider/model/session wiring for the real LLM layer. Required only when
   *  llmVerify is unset and skipLlm is false. */
  provider?: unknown;
  modelId?: string;
  pr?: number;
  sessionsRoot?: string;
  /** Per-finding timeout / retry for the LLM layer. Default 120_000 / 1 attempt. */
  timeoutMs?: number;
  maxAttempts?: number;
  retryBackoffMs?: number;
  /** Grep walker for the LLM layer's grep tool (test injection, like review.ts). */
  grepWalker?: GrepWalkerLike;
}

/** A single finding's verdict from the LLM layer. */
export interface LLMVerdict {
  /** "uphold" = body matches code; "demote" = body contradicts code. */
  verdict: "uphold" | "demote";
  /** Short reason, surfaced when demoting. */
  reason: string;
}

/** Injectable LLM verify function: read+grep to check one finding's body. */
export interface LLMVerifyFn {
  (comment: InlineComment, opts: VerifyOptions): Promise<LLMVerdict | null>;
}

/** Subset of the grep-walker signature we need (avoids importing tools.ts here). */
export interface GrepWalkerLike {
  (cwd: string, pattern: string, glob: string | undefined, cap: number): Promise<string>;
}

export interface VerifyResult {
  /** All findings, annotated. Order preserved from input. */
  comments: VerifiedComment[];
  summary: VerifySummary;
}

/**
 * Verify a batch of inline findings through both layers.
 *
 * The rule layer runs synchronously over every comment. The LLM layer then
 * runs (in parallel via Promise.all, mirroring runTeamReview's persona fan-out)
 * over the survivors. A null/throwing LLM verdict leaves the finding verified
 * — never demote on uncertainty.
 */
export async function verifyInlineComments(
  comments: InlineComment[],
  opts: VerifyOptions,
): Promise<VerifyResult> {
  // Layer 1: rule layer.
  const afterRules = await Promise.all(
    comments.map((c) => applyRuleLayer(c, opts.cwd, opts.changedLines)),
  );

  // Layer 2: LLM layer (only over findings that passed the rule layer).
  let annotated = afterRules;
  if (!opts.skipLlm && afterRules.some((c) => c.status === "verified")) {
    const llm = opts.llmVerify ?? null;
    if (llm) {
      annotated = await Promise.all(
        afterRules.map(async (c) => {
          if (c.status !== "verified") return c;
          try {
            const verdict = await llm(c, opts);
            if (verdict && verdict.verdict === "demote") {
              return { ...c, status: "demoted" as const, demoteReason: verdict.reason };
            }
            return c; // uphold, or verdict was null → stay verified
          } catch {
            // LLM failure must never demote a real finding.
            return c;
          }
        }),
      );
    }
  }

  const demotedList = annotated.filter((c): c is VerifiedComment => c.status === "demoted");
  return {
    comments: annotated,
    summary: {
      total: annotated.length,
      verified: annotated.length - demotedList.length,
      demoted: demotedList.length,
      demotedList,
    },
  };
}

// ── Layer 1: rule layer ─────────────────────────────────────────────────

/**
 * Check one finding against the diff's changed-line set + filesystem.
 * Pure except for the file-existence fs.access check (best-effort; an access
 * error is treated as "not found" rather than thrown, to stay fail-open).
 */
async function applyRuleLayer(
  comment: InlineComment,
  cwd: string,
  changedLines: Map<string, ChangedLines>,
): Promise<VerifiedComment> {
  // (a) File present in the diff at all? A finding on a file the PR didn't
  //     touch can't be pinned to a changed line.
  const fileLines = changedLines.get(comment.file);
  if (!fileLines) {
    return { ...comment, status: "demoted", demoteReason: "file not in diff" };
  }
  // (b) Line falls in the changed set for this side? The coordinator may cite
  //     a line number that exists in the file but wasn't changed by this PR.
  const sideSet = comment.side === "RIGHT" ? fileLines.right : fileLines.left;
  if (!sideSet.has(comment.line)) {
    return { ...comment, status: "demoted", demoteReason: `line ${comment.line} not changed on ${comment.side} side` };
  }
  // (c) File exists on disk? A path from the diff that the checkout can't
  //     resolve (deleted in a later commit, rename edge case) means we can't
  //     trust the pin. Best-effort: access failure → demote, never throw.
  try {
    await fs.access(path.resolve(cwd, comment.file));
  } catch {
    return { ...comment, status: "demoted", demoteReason: "file not found on disk" };
  }
  return { ...comment, status: "verified" };
}
