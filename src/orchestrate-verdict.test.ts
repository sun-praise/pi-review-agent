import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import type { Provider } from "@earendil-works/pi-ai";
import type { RunReviewOptions, ReviewResult } from "./review.js";

const EMPTY_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costTotal: 0 };

function fakeReview(content: string): ReviewResult {
  return {
    content,
    usage: EMPTY_USAGE,
    resumed: false,
    sessionId: "1-fake",
    newMessages: [],
  };
}

function fakeProvider(): Provider<"openai-completions"> {
  return { id: "litellm-deepseek" } as unknown as Provider<"openai-completions">;
}

// One review mock for the whole file (module cache): personas return CAN
// MERGE; the coordinator returns whatever the current test sets.
let coordinatorContent = "CAN MERGE\n\nfine";

mock.module("./review.js", {
  namedExports: {
    runReview: async (opts: RunReviewOptions): Promise<ReviewResult> =>
      fakeReview(opts.persona === "coordinator" ? coordinatorContent : "CAN MERGE\n\nfine"),
  },
});



async function runTeamVerdict(): Promise<string> {
  const { runTeamReview } = await import("./orchestrate.js");
  const result = await runTeamReview({
    provider: fakeProvider(),
    pr: 1,
    diff: "diff",
    cwd: process.cwd(),
    sessionsRoot: "/tmp/sessions",
    team: "quality",
  });
  return result.verdict;
}

describe("resolveVerdict <verdict> tag (authoritative)", () => {
  it("tag wins over keyword noise anywhere in prose — incl. quoted code at later offsets", async () => {
    // Repro from PR #54's own dogfood run: the coordinator's inline-comments
    // JSON quoted a code comment containing all three keywords, and the LAST
    // occurrence (inside that quote, offset 1864) beat the verdict itself
    // (offset 1836). The tag ends the ambiguity.
    coordinatorContent = [
      "I have all the information I need to synthesize the verdict.",
      "",
      "CAN MERGE",
      "",
      "<inline_comments>",
      "```json",
      "[]",
      "```",
      "</inline_comments>",
      "",
      'Note: the comment "CAN MERGE is not a substring of CONDITIONAL MERGE / CANNOT MERGE" explains the scans.',
      "",
      "<verdict>CAN MERGE</verdict>",
    ].join("\n");
    assert.equal(await runTeamVerdict(), "CAN MERGE");
  });

  it("tag is matched case-insensitively and tolerates surrounding whitespace", async () => {
    coordinatorContent = "Prose opening without keywords.\n\n<verdict>  cannot merge  </verdict>";
    assert.equal(await runTeamVerdict(), "CANNOT MERGE");
  });

  it("tag overrides even the first-line keyword when they disagree", async () => {
    coordinatorContent = "CONDITIONAL MERGE\n\n<verdict>CAN MERGE</verdict>";
    assert.equal(await runTeamVerdict(), "CAN MERGE");
  });
});

describe("resolveVerdict full-text fallback (last occurrence wins)", () => {
  it("a persona verdict quoted mid-body does not outrank the coordinator's concluding verdict", async () => {
    // Repro from the dogfood run on sun-praise PR #52: prose opening (no
    // first-line keyword), quoted persona verdicts, conclusion at the end.
    coordinatorContent = [
      "Everything is now consistent. The previous blocking issue has been resolved.",
      "",
      "- **quality**: CONDITIONAL MERGE, but explicitly states \"Blocking Issues: None\"",
      "- **security**: CAN MERGE",
      "",
      "Synthesis: CAN MERGE.",
    ].join("\n");
    assert.equal(await runTeamVerdict(), "CAN MERGE");
  });

  it("still prefers CANNOT when it is the coordinator's final word", async () => {
    coordinatorContent = [
      "Weighing the reviewers' outputs:",
      "One reviewer said CAN MERGE earlier, but the evidence contradicts it.",
      "",
      "Final verdict: CANNOT MERGE",
    ].join("\n");
    assert.equal(await runTeamVerdict(), "CANNOT MERGE");
  });

  it("first line stays canonical even when later prose contradicts it", async () => {
    coordinatorContent = "CANNOT MERGE\n\nThough parts of the change would be fine to CAN MERGE.";
    assert.equal(await runTeamVerdict(), "CANNOT MERGE");
  });

  it("no coordinator keyword anywhere falls back to the persona vote", async () => {
    coordinatorContent = "I could not determine a verdict from the inputs.";
    assert.equal(await runTeamVerdict(), "CAN MERGE");
  });
});
