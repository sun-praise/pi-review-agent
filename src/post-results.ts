/**
 * Posting orchestration for a finished team review: where the verdict lands.
 *
 * Two surfaces with different lifecycles:
 *  - PR review (Reviews API): carries inline findings, anchored to one commit,
 *    append-only — a re-run posts a new review, it can never refresh anything.
 *  - Issue comment: the standing top-level summary, edit-in-place per head SHA.
 *
 * Split out of index.ts so the posting policy is unit-testable (index.ts runs
 * main() at import time). #59: the old policy posted EITHER a review (when
 * inline findings existed) OR refreshed the comment — so every run with
 * inline findings left the top-level summary frozen at whatever an earlier,
 * possibly broken run had posted.
 */
import type {
  InlineComment,
  PlatformAdapter,
  PostReviewResult,
  PrCommentContext,
} from "./platforms/types.js";

export interface TeamPostOutcome {
  /** PR review outcome. Undefined when there were no inline findings. */
  review?: PostReviewResult;
  /** Top-level issue comment outcome (the durable summary surface). */
  comment: "created" | "updated" | "skipped";
}

/**
 * Post a team review: inline findings as a PR review (when present), then the
 * summary as the top-level issue comment — ALWAYS refreshed, never skipped
 * just because a review was posted.
 */
export async function postTeamResults(
  adapter: Pick<PlatformAdapter, "postReview" | "postComment">,
  ctx: PrCommentContext,
  body: string,
  inlineComments: InlineComment[],
): Promise<TeamPostOutcome> {
  if (inlineComments.length === 0) {
    return { comment: await adapter.postComment(ctx, body) };
  }
  const review = await adapter.postReview(ctx, body, inlineComments);
  // "created"/"updated" means the review layer already landed the summary AS
  // the issue comment (GitHub's comment fallback after the Reviews API
  // rejected the batch, or Gitea's single-comment flow with inline findings
  // folded in). Posting again would duplicate the body or overwrite those
  // folded findings — the comment is already current, so we're done.
  if (review === "created" || review === "updated") {
    return { review, comment: review };
  }
  // A posted review ("review"/"summary-review") never refreshes the standing
  // summary comment, so do it explicitly: a new head SHA gets a fresh
  // comment, a same-SHA re-run replaces the prior comment in place — e.g.
  // repairing an earlier garbage comment (#59). "skipped" (nothing landed)
  // also falls through: one more attempt costs nothing — but the review
  // layer's inline findings were lost with it, so say so instead of letting
  // a plain summary imply they were posted.
  if (review === "skipped") {
    process.stderr.write(
      `postTeamResults: review layer skipped posting; ${inlineComments.length} inline finding(s) did not reach the PR\n`,
    );
  }
  return { review, comment: await adapter.postComment(ctx, body) };
}
