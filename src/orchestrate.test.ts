import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderTeamComment, renderTeamReviewBody, type CommentTeamView } from "./team-comment.js";
import type { ReviewResult } from "./review.js";

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costTotal: number;
}

function review(content: string, usage: Usage, persona: string): ReviewResult {
  return { content, usage, resumed: false, sessionId: `1-${persona}`, newMessages: [] };
}

const OK_USAGE: Usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, costTotal: 0.0001 };
const EMPTY_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costTotal: 0 };

describe("renderTeamComment fail-closed", () => {
  it("shows CAN MERGE + no banner when all reviewers produced output", () => {
    const result: CommentTeamView = {
      personas: [{ persona: "quality", result: review("CAN MERGE\n\nfine", OK_USAGE, "quality") }],
      coordinator: { content: "CAN MERGE\n\nfine" },
      verdict: "CAN MERGE",
      totalCost: 0.0001,
      totalCacheRead: 0,
    };
    const body = renderTeamComment(result);
    assert.ok(body.includes("✅ CAN MERGE"));
    assert.ok(!body.includes("Fail-closed"));
  });

  it("shows 🚫 CANNOT MERGE + fail-closed banner when a reviewer failed", () => {
    // Coordinator said CAN MERGE (it saw mostly-empty inputs) but the caller
    // forced verdict to CANNOT MERGE. This is the exact regression scenario:
    // PR comment must not contradict the exit gate.
    const result: CommentTeamView = {
      personas: [
        { persona: "quality", result: review("", EMPTY_USAGE, "quality"), error: "no usage" },
        { persona: "security", result: review("CAN MERGE\n\nfine", OK_USAGE, "security") },
      ],
      coordinator: { content: "CAN MERGE\n\nlooks fine to me" },
      verdict: "CANNOT MERGE",
      totalCost: 0.0001,
      totalCacheRead: 0,
    };
    const body = renderTeamComment(result);
    assert.ok(body.includes("🚫 CANNOT MERGE"));
    assert.ok(body.includes("Fail-closed"));
    assert.ok(body.includes("quality"));
    assert.ok(body.includes("_(review failed: no usage)_"));
  });
});

describe("renderTeamComment verification", () => {
  it("shows the verification summary line when verification ran", () => {
    const result: CommentTeamView = {
      personas: [{ persona: "quality", result: review("CAN MERGE\n\nfine", OK_USAGE, "quality") }],
      coordinator: { content: "CAN MERGE\n\nfine" },
      verdict: "CAN MERGE",
      totalCost: 0.0001,
      totalCacheRead: 0,
      verification: { total: 3, verified: 2, demoted: 1, demotedList: [] },
    };
    const body = renderTeamComment(result);
    assert.ok(body.includes("🔍 **Verification:** 2/3"));
    assert.ok(body.includes("1 demoted"));
  });

  it("omits the verification line when no verification ran (skip-verify regression guard)", () => {
    const result: CommentTeamView = {
      personas: [{ persona: "quality", result: review("CAN MERGE\n\nfine", OK_USAGE, "quality") }],
      coordinator: { content: "CAN MERGE\n\nfine" },
      verdict: "CAN MERGE",
      totalCost: 0.0001,
      totalCacheRead: 0,
      // no verification field — pre-verifier / skip-verify path
    };
    const body = renderTeamComment(result);
    assert.ok(!body.includes("Verification"));
  });

  it("lists demoted findings with their reasons in a collapsible section", () => {
    const result: CommentTeamView = {
      personas: [{ persona: "quality", result: review("CAN MERGE", OK_USAGE, "quality") }],
      coordinator: { content: "CAN MERGE" },
      verdict: "CAN MERGE",
      totalCost: 0.0001,
      totalCacheRead: 0,
      verification: {
        total: 2,
        verified: 1,
        demoted: 1,
        demotedList: [
          {
            file: "src/auth.ts",
            line: 99,
            side: "RIGHT",
            severity: "blocking",
            body: "unvalidated call",
            status: "demoted",
            demoteReason: "line 99 not changed on RIGHT side",
          },
        ],
      },
    };
    const body = renderTeamComment(result);
    assert.ok(body.includes("Demoted findings"));
    assert.ok(body.includes("`src/auth.ts:99`"));
    assert.ok(body.includes("line 99 not changed"));
    assert.ok(body.includes("unvalidated call"));
  });
});

describe("renderTeamReviewBody (slim review surface, #62)", () => {
  it("keeps verdict, verification digest and pointer; drops the long sections", () => {
    const result: CommentTeamView = {
      personas: [{ persona: "quality", result: review("CAN MERGE\n\nfine", OK_USAGE, "quality") }],
      coordinator: { content: "CAN MERGE\n\nfine — long synthesis text" },
      verdict: "CAN MERGE",
      totalCost: 0.0001,
      totalCacheRead: 0,
      verification: { total: 3, verified: 2, demoted: 1, demotedList: [] },
    };
    const body = renderTeamReviewBody(result);
    assert.ok(body.includes("✅ CAN MERGE"));
    assert.ok(body.includes("🔍 **Verification:** 2/3"));
    assert.ok(body.includes("top-level"));
    // The full synthesis and per-reviewer sections stay on the comment surface.
    assert.ok(!body.includes("Coordinator synthesis"));
    assert.ok(!body.includes("long synthesis text"));
    assert.ok(!body.includes("quality"));
  });

  it("duplicates the fail-closed banner — safety notes must be readable from the review timeline too", () => {
    const result: CommentTeamView = {
      personas: [
        { persona: "quality", result: review("", EMPTY_USAGE, "quality"), error: "no usage" },
      ],
      coordinator: { content: "CAN MERGE" },
      verdict: "CANNOT MERGE",
      totalCost: 0,
      totalCacheRead: 0,
    };
    const body = renderTeamReviewBody(result);
    assert.ok(body.includes("🚫 CANNOT MERGE"));
    assert.ok(body.includes("Fail-closed"));
    assert.ok(body.includes("quality"));
  });
});
