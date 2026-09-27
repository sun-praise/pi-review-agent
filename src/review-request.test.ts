import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildReviewRequest } from "./review-request.js";
import { SELF_MARKER, SHA_LINE_PREFIX, SHA_LINE_SUFFIX } from "./review-anchor.js";

const DIFF = "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new";
const SINCE = "0123456789abcdef0123456789abcdef01234567";

describe("buildReviewRequest — full review (legacy format)", () => {
  it("no context blocks → bare instruction + diff", () => {
    assert.equal(buildReviewRequest({ diff: DIFF }), `Review this diff:\n\n${DIFF}`);
  });

  it("with context blocks → prefix, header, instruction, diff", () => {
    const out = buildReviewRequest({ diff: DIFF, prContext: "PR", relatedContext: "RELATED" });
    assert.equal(out, `PR\n\nRELATED\n\n=== Review request ===\nReview this diff:\n\n${DIFF}`);
  });

  it("blank context blocks are skipped", () => {
    assert.equal(
      buildReviewRequest({ diff: DIFF, prContext: "  ", relatedContext: "" }),
      `Review this diff:\n\n${DIFF}`,
    );
  });
});

describe("buildReviewRequest — incremental", () => {
  it("switches the request wording and names the anchor commit", () => {
    const out = buildReviewRequest({ diff: DIFF, incrementalSince: SINCE });
    assert.ok(out.includes("Incremental review"));
    assert.ok(out.includes(SINCE));
    assert.ok(out.includes(DIFF));
    assert.ok(!out.includes("<previous_review>"), "no anchor body → no previous-review block");
  });

  it("wraps the previous round's summary with markers stripped", () => {
    const previous = `${SELF_MARKER}\n${SHA_LINE_PREFIX}${SINCE}${SHA_LINE_SUFFIX}\nverdict: CANNOT MERGE`;
    const out = buildReviewRequest({ diff: DIFF, incrementalSince: SINCE, previousReview: previous });
    assert.ok(out.includes("<previous_review>"));
    assert.ok(out.includes("verdict: CANNOT MERGE"));
    assert.ok(!out.includes(SELF_MARKER));
    assert.ok(!out.includes(SHA_LINE_PREFIX));
  });

  it("caps the injected previous review and says so", () => {
    const long = "x".repeat(20_000);
    const out = buildReviewRequest({ diff: DIFF, incrementalSince: SINCE, previousReview: long });
    assert.ok(out.length < 22_000);
    assert.ok(out.includes("previous review truncated"));
  });

  it("keeps the previous-review block even without pr/related context", () => {
    const out = buildReviewRequest({
      diff: DIFF,
      incrementalSince: SINCE,
      previousReview: "prior findings",
    });
    assert.ok(out.startsWith("<previous_review>"));
    assert.ok(out.includes("New changes since"));
  });
});
