import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderTeamComment, renderTeamReviewBody } from "./team-comment.js";
import type { CommentTeamView } from "./team-comment.js";

/** Minimal view: no personas, no coordinator, no verification roll-up. */
function baseView(overrides: Partial<CommentTeamView> = {}): CommentTeamView {
  return {
    personas: [],
    coordinator: null,
    verdict: "CONDITIONAL MERGE",
    totalCost: 0,
    totalCacheRead: 0,
    ...overrides,
  };
}

describe("unverified-verdict banner (#67)", () => {
  it("renderTeamComment carries the banner when blockingAllDemoted is set", () => {
    const body = renderTeamComment(baseView({ blockingAllDemoted: true }));
    assert.ok(body.includes("Unverified verdict"));
    assert.ok(body.includes("re-review before merging"));
  });

  it("renderTeamComment omits the banner by default", () => {
    const body = renderTeamComment(baseView());
    assert.ok(!body.includes("Unverified verdict"));
  });

  it("renderTeamReviewBody duplicates the banner (points at the top-level comment)", () => {
    const body = renderTeamReviewBody(baseView({ blockingAllDemoted: true }));
    assert.ok(body.includes("Unverified verdict"));
    assert.ok(body.includes("top-level summary comment"));
  });

  it("renderTeamReviewBody omits the banner by default", () => {
    const body = renderTeamReviewBody(baseView());
    assert.ok(!body.includes("Unverified verdict"));
  });

  it("banner sits at the top, before the coordinator synthesis it qualifies", () => {
    const body = renderTeamComment(
      baseView({ blockingAllDemoted: true, coordinator: { content: "CONDITIONAL MERGE ..." } }),
    );
    assert.ok(body.indexOf("Unverified verdict") < body.indexOf("Coordinator synthesis"));
  });
});
