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

type ReviewOutcome = "review" | "summary-review" | "created" | "updated" | "skipped";
type CommentOutcome = "created" | "updated" | "skipped";

/** Recording fake adapter: postReview/postComment return scripted outcomes. */
function fakeAdapter(review: ReviewOutcome, comment: CommentOutcome = "updated") {
  const calls: { review: number; reviewBody: string; comment: number; commentBody: string } = {
    review: 0,
    reviewBody: "",
    comment: 0,
    commentBody: "",
  };
  return {
    calls,
    adapter: {
      async postReview(_ctx: PrCommentContext, body: string, _comments: InlineComment[]): Promise<ReviewOutcome> {
        calls.review++;
        calls.reviewBody = body;
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
    const outcome = await postTeamResults(adapter, CTX, "summary", []);
    assert.deepEqual(outcome, { comment: "updated" });
    assert.equal(calls.review, 0);
    assert.equal(calls.comment, 1);
    assert.equal(calls.commentBody, "summary");
  });

  await t.test("review posted: ALSO refreshes the top-level comment (#59)", async () => {
    // The old behavior posted only the review, leaving a stale (possibly
    // broken) top-level comment as the standing summary forever.
    const { calls, adapter } = fakeAdapter("review");
    const outcome = await postTeamResults(adapter, CTX, "summary", INLINE);
    assert.deepEqual(outcome, { review: "review", comment: "updated" });
    assert.equal(calls.review, 1);
    assert.equal(calls.comment, 1);
  });

  await t.test("summary-only review: still refreshes the top-level comment", async () => {
    const { calls, adapter } = fakeAdapter("summary-review", "created");
    const outcome = await postTeamResults(adapter, CTX, "summary", INLINE);
    assert.deepEqual(outcome, { review: "summary-review", comment: "created" });
    assert.equal(calls.review, 1);
    assert.equal(calls.comment, 1);
  });

  await t.test("review layer already landed a comment: does not post twice", async () => {
    // "created"/"updated" means the summary landed AS the issue comment
    // (GitHub fallback after the Reviews API rejected the batch, or Gitea
    // folding inline findings into the single comment). A second post would
    // duplicate or overwrite the folded findings.
    const { calls, adapter } = fakeAdapter("created");
    const outcome = await postTeamResults(adapter, CTX, "summary", INLINE);
    assert.deepEqual(outcome, { review: "created", comment: "created" });
    assert.equal(calls.review, 1);
    assert.equal(calls.comment, 0);
  });

  await t.test("skipped review: still attempts the comment", async () => {
    const { calls, adapter } = fakeAdapter("skipped", "skipped");
    const outcome = await postTeamResults(adapter, CTX, "summary", INLINE);
    assert.deepEqual(outcome, { review: "skipped", comment: "skipped" });
    assert.equal(calls.review, 1);
    assert.equal(calls.comment, 1);
  });
});
