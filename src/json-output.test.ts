import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSingleJsonResult, buildTeamJsonResult } from "./json-output.js";
import type { ReviewResult, ReviewUsage } from "./review.js";
import type { TeamReviewResult, PersonaReview } from "./orchestrate.js";
import type { InlineComment } from "./inline-comments.js";
import type { VerifySummary } from "./verifier.js";
import type { Severity } from "./severity.js";

function usage(partial: Partial<ReviewUsage> = {}): ReviewUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costTotal: 0, ...partial };
}

function review(partial: Partial<ReviewResult> = {}): ReviewResult {
  return {
    content: "CAN MERGE\n\nfine.",
    usage: usage({ input: 100, output: 50, cacheRead: 10, cacheWrite: 5, costTotal: 0.001 }),
    resumed: false,
    sessionId: "1-quality",
    newMessages: [],
    ...partial,
  };
}

const SEVERITY: Severity = { decision: "CAN MERGE", blockingCount: 0, warningCount: 0, fallback: false };

const COMMENTS: InlineComment[] = [
  { file: "src/auth.ts", line: 42, side: "RIGHT", severity: "blocking", body: "SQL injection", status: "verified" },
  { file: "src/util.ts", line: 7, side: "LEFT", severity: "suggestion", body: "rename foo", status: "verified" },
];

const VERIFICATION: VerifySummary = {
  total: 3,
  verified: 2,
  demoted: 1,
  demotedList: [
    {
      file: "src/gone.ts",
      line: 99,
      side: "RIGHT",
      severity: "warning",
      body: "hallucinated",
      status: "demoted",
      demoteReason: "file not in diff",
    },
  ],
};

function teamResult(partial: Partial<TeamReviewResult> = {}): TeamReviewResult {
  const personas: PersonaReview[] = [
    { persona: "quality", result: review({ usage: usage({ input: 100, cacheRead: 10, costTotal: 0.001 }) }) },
    {
      persona: "security",
      result: review({ content: "(review failed)", usage: usage() }),
      error: "all models failed",
    },
  ];
  const coordinator = review({
    sessionId: "1-coordinator",
    usage: usage({ input: 200, cacheRead: 20, costTotal: 0.002 }),
  });
  return {
    personas,
    coordinator,
    verdict: "CANNOT MERGE",
    totalCost: 0.003,
    totalCacheRead: 30,
    severity: { ...SEVERITY, decision: "CANNOT MERGE", blockingCount: 2 },
    inlineComments: COMMENTS,
    verification: VERIFICATION,
    ...partial,
  };
}

describe("buildTeamJsonResult", () => {
  it("aggregates usage across personas + coordinator", () => {
    const json = buildTeamJsonResult({ pr: 7, result: teamResult() });
    assert.equal(json.usage.input, 300); // 100 + 0 (failed) + 200
    assert.equal(json.usage.cacheRead, 30);
    assert.ok(Math.abs(json.usage.costTotal - 0.003) < 1e-9);
  });

  it("carries verdict, severity, verified comments, and the verifier summary", () => {
    const json = buildTeamJsonResult({ pr: 7, result: teamResult() });
    assert.equal(json.mode, "team");
    assert.equal(json.pr, 7);
    assert.equal(json.verdict, "CANNOT MERGE");
    assert.equal(json.severity.decision, "CANNOT MERGE");
    assert.deepEqual(json.comments, COMMENTS);
    assert.ok(json.comments.every((c) => c.status === "verified"));
    assert.deepEqual(json.verification, VERIFICATION);
  });

  it("carries coordinatorError so a harness can tell skipped from crashed", () => {
    const json = buildTeamJsonResult({
      pr: 7,
      result: teamResult({ coordinator: null, coordinatorError: "all models failed" }),
    });
    assert.equal(json.coordinator, null);
    assert.equal(json.coordinatorError, "all models failed");
    const skipped = buildTeamJsonResult({
      pr: 7,
      result: teamResult({ coordinator: null, coordinatorError: undefined }),
    });
    assert.equal("coordinatorError" in skipped, false);
  });

  it("reports per-persona usage and surfaces reviewer errors", () => {
    const json = buildTeamJsonResult({ pr: 7, result: teamResult() });
    assert.equal(json.personas.length, 2);
    const failed = json.personas.find((p) => p.persona === "security");
    assert.ok(failed);
    assert.equal(failed.error, "all models failed");
    assert.equal(json.personas.find((p) => p.persona === "quality")?.error, undefined);
    assert.equal(json.coordinator?.resumed, false);
    assert.equal(json.coordinator?.usage.input, 200);
  });

  it("handles coordinator-less results (skip-coordinator) and drops absent optionals on stringify", () => {
    const json = buildTeamJsonResult({
      pr: 7,
      result: teamResult({ coordinator: null, inlineComments: [], verification: undefined }),
    });
    assert.equal(json.coordinator, null);
    const parsed = JSON.parse(JSON.stringify(json));
    assert.equal("verification" in parsed, false);
    assert.equal("sessionKey" in parsed, false);
    assert.deepEqual(parsed.comments, []);
  });

  it("carries sessionKey and blockingAllDemoted when present", () => {
    const json = buildTeamJsonResult({
      pr: 0,
      sessionKey: "aacr__instance-42",
      result: teamResult({ blockingAllDemoted: true }),
    });
    assert.equal(json.sessionKey, "aacr__instance-42");
    assert.equal(json.blockingAllDemoted, true);
  });
});

describe("buildSingleJsonResult", () => {
  it("wraps the lone reviewer: content + usage, no structured comments", () => {
    const result = review();
    const json = buildSingleJsonResult({ pr: 9, persona: "quality", result, severity: SEVERITY });
    assert.equal(json.mode, "single");
    assert.equal(json.pr, 9);
    assert.equal(json.content, result.content);
    assert.deepEqual(json.comments, []);
    assert.equal(json.personas.length, 1);
    assert.deepEqual(json.personas[0]?.usage, result.usage);
    assert.deepEqual(json.usage, result.usage);
    assert.equal("verdict" in json, false);
    assert.equal("coordinator" in json, false);
  });
});
