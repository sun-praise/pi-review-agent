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
  return {
    id: "litellm-deepseek",
  } as unknown as Provider<"openai-completions">;
}

// One review mock for the whole file: node:test caches the imported module,
// so re-mocking per test would silently keep the first binding. Tests dispatch
// on opts.persona and share state through these closure variables instead.
const reviewCalls: Array<RunReviewOptions> = [];
let coordinatorContent = "CAN MERGE\n\nfine";

mock.module("./review.js", {
  namedExports: {
    runReview: async (opts: RunReviewOptions): Promise<ReviewResult> => {
      reviewCalls.push(opts);
      return fakeReview(opts.persona === "coordinator" ? coordinatorContent : "CAN MERGE\n\nfine");
    },
  },
});

const verifierBuilds: Array<{ cwd: string; modelId?: string }> = [];

mock.module("./verifier-agent.js", {
  namedExports: {
    buildVerifierAgent: (
      _provider: Provider<"openai-completions">,
      opts: { cwd: string; modelId?: string },
    ) => {
      verifierBuilds.push(opts);
      return async () => null;
    },
  },
});

const DIFF = [
  "diff --git a/src/fallback.ts b/src/fallback.ts",
  "index 111..222 100644",
  "--- a/src/fallback.ts",
  "+++ b/src/fallback.ts",
  "@@ -1,3 +1,4 @@",
  " line1",
  "+line2",
  " line3",
].join("\n");

function coordinatorWithInlineComment(): string {
  return [
    "CONDITIONAL MERGE",
    "",
    "<inline_comments>",
    JSON.stringify([
      { file: "src/fallback.ts", line: 2, side: "RIGHT", severity: "warning", body: "check this" },
    ]),
    "</inline_comments>",
  ].join("\n");
}

describe("runTeamReview per-role model routing", () => {
  it("routes coordinatorModelId to the coordinator only; reviewers keep modelId", async () => {
    const { runTeamReview } = await import("./orchestrate.js");
    reviewCalls.length = 0;
    await runTeamReview({
      provider: fakeProvider(),
      pr: 1,
      diff: DIFF,
      cwd: process.cwd(),
      sessionsRoot: "/tmp/sessions",
      team: "quality",
      modelId: "cheap-model",
      coordinatorModelId: "strong-model",
    });

    assert.equal(reviewCalls.length, 2); // quality reviewer + coordinator
    assert.equal(reviewCalls[0].persona, "quality");
    assert.equal(reviewCalls[0].modelId, "cheap-model");
    assert.equal(reviewCalls[1].persona, "coordinator");
    assert.equal(reviewCalls[1].modelId, "strong-model");
  });

  it("coordinator falls back to modelId when coordinatorModelId is unset", async () => {
    const { runTeamReview } = await import("./orchestrate.js");
    reviewCalls.length = 0;
    await runTeamReview({
      provider: fakeProvider(),
      pr: 1,
      diff: DIFF,
      cwd: process.cwd(),
      sessionsRoot: "/tmp/sessions",
      team: "quality",
      modelId: "cheap-model",
    });

    assert.equal(reviewCalls[1].persona, "coordinator");
    assert.equal(reviewCalls[1].modelId, "cheap-model");
  });

  it("routes verifierModelId to the LLM verifier", async () => {
    coordinatorContent = coordinatorWithInlineComment();
    const { runTeamReview } = await import("./orchestrate.js");
    verifierBuilds.length = 0;
    await runTeamReview({
      provider: fakeProvider(),
      pr: 1,
      diff: DIFF,
      cwd: process.cwd(),
      sessionsRoot: "/tmp/sessions",
      team: "quality",
      modelId: "cheap-model",
      verifierModelId: "strong-model",
    });

    assert.equal(verifierBuilds.length, 1);
    assert.equal(verifierBuilds[0].modelId, "strong-model");
  });

  it("verifier falls back to modelId when verifierModelId is unset", async () => {
    verifierBuilds.length = 0;
    const { runTeamReview } = await import("./orchestrate.js");
    await runTeamReview({
      provider: fakeProvider(),
      pr: 1,
      diff: DIFF,
      cwd: process.cwd(),
      sessionsRoot: "/tmp/sessions",
      team: "quality",
      modelId: "cheap-model",
    });

    assert.equal(verifierBuilds.length, 1);
    assert.equal(verifierBuilds[0].modelId, "cheap-model");
  });
});
