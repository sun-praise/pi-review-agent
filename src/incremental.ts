/**
 * Incremental-review decision, extracted from index.ts (which executes
 * main() on import and cannot be loaded by `node --test`) so the full
 * decision tree — anchor, delta, and every fallback to a full review — is
 * unit-testable. index.ts applies the outcome to CliOptions.
 *
 * The contract: incremental is strictly an optimization layered on the
 * full-diff flow. A delta run is only returned when it is SAFE:
 *   - the full filtered diff is available (the verifier baseline and the
 *     no-diff-source error path both assume it — checked FIRST, before any
 *     network or git work),
 *   - a self-authored anchor exists (marker + fingerprint + identity check),
 *   - the anchor commit is an ancestor of head (rebase/force-push → full),
 *   - the delta is non-empty (an empty diff would collide with loadDiff's
 *     falsy-source check and crash the run with "no diff source").
 * Anything else → mode "full" with the reason for the log and stats. Never
 * throws.
 *
 * Pure-ish: all I/O (platform adapter, delta computation) is injected.
 */
import type { PlatformAdapter, PrContextOptions, PrInfo } from "./platforms/types.js";
import { computeDeltaDiff, type DeltaResult } from "./delta-diff.js";

/** The adapter surface this resolver needs (PlatformAdapter satisfies it). */
export type IncrementalAdapter = Pick<
  PlatformAdapter,
  "resolvePrFromEnv" | "getLastReviewAnchor" | "fetchCompareDiff"
>;

export interface IncrementalQuery {
  /** Force a full review regardless of anchors (label/command trigger). */
  forceFull: boolean;
  pr: number;
  cwd: string;
}

export type IncrementalOutcome =
  | { mode: "full"; reason: string }
  | {
      mode: "delta";
      /** The anchor commit — delta starts here; also the previous round's sha. */
      since: string;
      /** The anchor comment's body (the previous synthesis to carry forward). */
      previousReview: string;
      delta: string;
      /** The full filtered diff, kept as the verifier's changed-lines baseline. */
      fullDiff: string;
    };

export async function resolveIncremental(
  query: IncrementalQuery,
  adapter: IncrementalAdapter,
  /** The memoized full filtered diff — undefined when no diff source loaded. */
  fullDiff: string | undefined,
  env: NodeJS.ProcessEnv,
  deps: { computeDelta?: typeof computeDeltaDiff } = {},
): Promise<IncrementalOutcome> {
  if (query.forceFull) {
    return { mode: "full", reason: "force-full set" };
  }
  // Before any I/O: without the full diff there is no verifier baseline, and
  // the run's "no diff source" misconfiguration would be silently rescued
  // into an incremental-only review. Keep the loud failure path.
  if (fullDiff === undefined) {
    return { mode: "full", reason: "full diff unavailable — incremental swap skipped" };
  }
  const prInfo: PrInfo | null = adapter.resolvePrFromEnv(env);
  if (!prInfo || !prInfo.headSha) {
    return { mode: "full", reason: "no platform PR identity (pr/head sha)" };
  }
  const anchorOptions: PrContextOptions = {
    apiBase: prInfo.apiBase,
    repository: prInfo.repository,
    pr: query.pr,
    token: prInfo.token,
  };
  const anchor = await adapter.getLastReviewAnchor(anchorOptions);
  if (!anchor) {
    return { mode: "full", reason: "no prior review anchor" };
  }
  if (anchor.sha === prInfo.headSha) {
    return { mode: "full", reason: "anchor already at head (re-run of the same commit)" };
  }
  const compute = deps.computeDelta ?? computeDeltaDiff;
  const result: DeltaResult = await compute(anchor.sha, prInfo.headSha, query.cwd, {
    fetchCompare: (base, head) => adapter.fetchCompareDiff({ ...anchorOptions, base, head }),
  });
  if (result.error === "non-ancestor") {
    return {
      mode: "full",
      reason: `anchor ${anchor.sha.slice(0, 8)} is not an ancestor of head (rebase/force-push) — full review`,
    };
  }
  if (result.error === "unavailable") {
    return {
      mode: "full",
      reason: `delta since ${anchor.sha.slice(0, 8)} unavailable (git and compare both failed) — full review`,
    };
  }
  if (result.diff.trim() === "") {
    // Nothing reviewable changed since the anchor (rebase squash, amend-only
    // message edit, empty re-push). Falling through with "" would hit
    // loadDiff's falsy-source check and crash the run with "no diff source"
    // — a full review is the safe degradation.
    return {
      mode: "full",
      reason: "delta is empty (nothing changed since the anchor; e.g. rebase/amend-only)",
    };
  }
  return {
    mode: "delta",
    since: anchor.sha,
    previousReview: anchor.body,
    delta: result.diff,
    fullDiff,
  };
}
