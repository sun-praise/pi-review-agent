import assert from "node:assert/strict";
import test from "node:test";

import { postTeamResults } from "./post-results.js";
import type { InlineComment, PrCommentContext } from "./platforms/types.js";

const CTX: PrCommentContext = {
  apiBase: "https://api.test.local",
  repository: "octocat/Hello-World",
  pr: 42,
  token: "tkn",
  headSha: "abc123",
};

const INLINE: InlineComment[] = [
  { file: "src/a.ts", line: 10, side: "RIGHT", severity: "blocking", body: "bug" },
];

const FULL = "full summary body";
const SLIM = "slim review body";

type ReviewOutcome = "review" | "summary-review" | "created" | "updated" | "skipped";
type CommentOutcome = "created" | "updated" | "skipped";

/** Recording fake adapter: postReview/postComment return scripted outcomes. */
function fakeAdapter(review: ReviewOutcome, comment: CommentOutcome = "updated") {
  const calls: {
    review: number;
    reviewBody: string;
    commentFallback?: string;
    comment: number;
    commentBody: string;
  } = {
    review: 0,
    reviewBody: "",
    comment: 0,
    commentBody: "",
  };
  return {
    calls,
    adapter: {
      async postReview(
        _ctx: PrCommentContext,
        body: string,
        _comments: InlineComment[],
        commentFallback?: string,
      ): Promise<ReviewOutcome> {
        calls.review++;
        calls.reviewBody = body;
        calls.commentFallback = commentFallback;
        return review;
      },
      async postComment(_ctx: PrCommentContext, body: string): Promise<CommentOutcome> {
        calls.comment++;
        calls.commentBody = body;
        return comment;
      },
    },
  };
}

test("postTeamResults", async (t) => {
  await t.test("no inline findings: refreshes the comment only", async () => {
    const { calls, adapter } = fakeAdapter("review");
    const outcome = await postTeamResults(adapter, CTX, FULL, SLIM, []);
    assert.deepEqual(outcome, { comment: "updated" });
    assert.equal(calls.review, 0);
    assert.equal(calls.comment, 1);
    assert.equal(calls.commentBody, FULL);
  });

  await t.test("review posted: slim body on the review, full on the comment (#62)", async () => {
    // The review surface carries only the slim digest — a full body there
    // stacked duplicate long bodies per push. The standing comment keeps
    // the full synthesis, and the review layer's fallback body is the full
    // one so a degraded run never lands slim-only.
    const { calls, adapter } = fakeAdapter("review");
    const outcome = await postTeamResults(adapter, CTX, FULL, SLIM, INLINE);
    assert.deepEqual(outcome, { review: "review", comment: "updated" });
    assert.equal(calls.review, 1);
    assert.equal(calls.reviewBody, SLIM);
    assert.equal(calls.commentFallback, FULL);
    assert.equal(calls.comment, 1);
    assert.equal(calls.commentBody, FULL);
  });

  await t.test("summary-only review: still refreshes the top-level comment", async () => {
    const { calls, adapter } = fakeAdapter("summary-review", "created");
    const outcome = await postTeamResults(adapter, CTX, FULL, SLIM, INLINE);
    assert.deepEqual(outcome, { review: "summary-review", comment: "created" });
    assert.equal(calls.review, 1);
    assert.equal(calls.comment, 1);
  });

  await t.test("review layer already landed a comment: does not post twice", async () => {
    // "created"/"updated" means the summary landed AS the issue comment
    // (GitHub fallback after the Reviews API rejected the batch, or Gitea
    // folding inline findings into the single comment). A second post would
    // duplicate or overwrite the folded findings — and the landed body must
    // be the FULL fallback, not the slim review body.
    const { calls, adapter } = fakeAdapter("created");
    const outcome = await postTeamResults(adapter, CTX, FULL, SLIM, INLINE);
    assert.deepEqual(outcome, { review: "created", comment: "created" });
    assert.equal(calls.review, 1);
    assert.equal(calls.reviewBody, SLIM);
    assert.equal(calls.commentFallback, FULL);
    assert.equal(calls.comment, 0);
  });

  await t.test("skipped review: still attempts the comment", async () => {
    const { calls, adapter } = fakeAdapter("skipped", "skipped");
    const outcome = await postTeamResults(adapter, CTX, FULL, SLIM, INLINE);
    assert.deepEqual(outcome, { review: "skipped", comment: "skipped" });
    assert.equal(calls.review, 1);
    assert.equal(calls.comment, 1);
    assert.equal(calls.commentBody, FULL);
  });
});
