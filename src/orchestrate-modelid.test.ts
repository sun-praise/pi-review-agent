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

describe("runTeamReview passes modelId to every reviewer", () => {
  it("forwards modelId to persona and coordinator runReview calls", async () => {
    const calls: Array<RunReviewOptions> = [];

    mock.module("./review.js", {
      namedExports: {
        runReview: async (opts: RunReviewOptions): Promise<ReviewResult> => {
          calls.push(opts);
          return fakeReview("CAN MERGE\n\nfine");
        },
      },
    });

    const { runTeamReview } = await import("./orchestrate.js");
    const result = await runTeamReview({
      provider: fakeProvider(),
      pr: 1,
      diff: "diff",
      cwd: process.cwd(),
      sessionsRoot: "/tmp/sessions",
      team: "quality",
      modelId: "mimo-v2.5",
    });

    assert.equal(result.personas.length, 1);
    assert.equal(calls.length, 2); // quality + coordinator
    for (const call of calls) {
      assert.equal(call.modelId, "mimo-v2.5", `expected modelId forwarded, got ${call.modelId}`);
    }
  });
});
