import { describe, it, mock, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
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

const calls: Array<RunReviewOptions> = [];
let runTeamReview: typeof import("./orchestrate.js").runTeamReview;

describe("runTeamReview style-guide injection", () => {
  before(async () => {
    mock.module("./review.js", {
      namedExports: {
        runReview: async (opts: RunReviewOptions): Promise<ReviewResult> => {
          calls.push(opts);
          return fakeReview("CAN MERGE\n\nfine");
        },
      },
    });
    const mod = await import("./orchestrate.js");
    runTeamReview = mod.runTeamReview;
  });

  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "orchestrate-sg-"));
    calls.length = 0;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("injects the style-guide into the quality persona prompt", async () => {
    writeFileSync(path.join(tmpDir, "STYLE_GUIDE.md"), "Use 2-space indentation.");
    await runTeamReview({
      provider: fakeProvider(),
      pr: 1,
      diff: "diff",
      cwd: tmpDir,
      sessionsRoot: "/tmp/sessions",
      team: "quality",
    });

    const qualityCall = calls.find((c) => c.persona === "quality");
    assert.ok(qualityCall?.systemPrompt?.includes("Use 2-space indentation."));
  });

  it("does not inject the style-guide into the security persona prompt", async () => {
    writeFileSync(path.join(tmpDir, "STYLE_GUIDE.md"), "Use 2-space indentation.");
    await runTeamReview({
      provider: fakeProvider(),
      pr: 1,
      diff: "diff",
      cwd: tmpDir,
      sessionsRoot: "/tmp/sessions",
      team: "security",
    });

    const securityCall = calls.find((c) => c.persona === "security");
    assert.ok(securityCall);
    assert.ok(!securityCall?.systemPrompt?.includes("Use 2-space indentation."));
  });

  it("injects the style-guide into a custom persona with use-style-guide: true", async () => {
    writeFileSync(path.join(tmpDir, "STYLE_GUIDE.md"), "No trailing commas.");
    const reviewers = path.join(tmpDir, ".github", "reviewers");
    mkdirSync(reviewers, { recursive: true });
    writeFileSync(
      path.join(reviewers, "custom.yaml"),
      ["name: custom", "prompt: Custom reviewer.", "use-style-guide: true"].join("\n"),
    );
    await runTeamReview({
      provider: fakeProvider(),
      pr: 1,
      diff: "diff",
      cwd: tmpDir,
      sessionsRoot: "/tmp/sessions",
      team: "custom",
    });

    const customCall = calls.find((c) => c.persona === "custom");
    assert.ok(customCall?.systemPrompt?.includes("No trailing commas."));
  });

  it("uses an explicit style-guide path over auto-detection", async () => {
    writeFileSync(path.join(tmpDir, "STYLE_GUIDE.md"), "root guide");
    mkdirSync(path.join(tmpDir, "docs"));
    writeFileSync(path.join(tmpDir, "docs", "override.md"), "override guide");
    await runTeamReview({
      provider: fakeProvider(),
      pr: 1,
      diff: "diff",
      cwd: tmpDir,
      sessionsRoot: "/tmp/sessions",
      team: "quality",
      styleGuide: "docs/override.md",
    });

    const qualityCall = calls.find((c) => c.persona === "quality");
    assert.ok(qualityCall?.systemPrompt?.includes("override guide"));
    assert.ok(!qualityCall?.systemPrompt?.includes("root guide"));
  });
});
