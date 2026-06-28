import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderTeamComment, type CommentTeamView } from "./team-comment.js";
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
