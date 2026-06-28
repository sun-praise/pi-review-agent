import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSeverity, shouldFail, withFailedReviewerOverride, type FailMode } from "./severity.js";

const CLEAN = [
  "CAN MERGE",
  "",
  "Looks fine.",
  "",
  "### Blocking Issues",
  "None",
  "### Warnings",
  "None",
  "### Suggestions",
  "None",
].join("\n");

const WITH_BLOCKER = [
  "CANNOT MERGE",
  "",
  "Bad.",
  "",
  "### Blocking Issues",
  "1. SQL injection in login",
  "2. Null deref in parser",
  "### Warnings",
  "- Missing test for edge case",
  "### Suggestions",
  "- Rename foo",
].join("\n");

const WARNINGS_ONLY = [
  "CAN MERGE",
  "",
  "### Blocking Issues",
  "None",
  "### Warnings",
  "- Naming is inconsistent",
  "- Add a comment",
  "### Suggestions",
  "None",
].join("\n");

const ZH = [
  "不可合并 / CANNOT MERGE",
  "",
  "### 🔴 阻塞项 / Blocking Issues",
  "- 注入风险",
  "### 🟡 警告项 / Warnings",
  "- 命名不一致",
].join("\n");

const GARBAGE = "the model went off on a tangent and produced no headings at all";

describe("parseSeverity", () => {
  it("counts blocking and warning items from English output", () => {
    const s = parseSeverity(WITH_BLOCKER);
    assert.equal(s.decision, "CANNOT MERGE");
    assert.equal(s.blockingCount, 2);
    assert.equal(s.warningCount, 1);
    assert.equal(s.fallback, false);
  });

  it("reads zero counts for a clean CAN MERGE", () => {
    const s = parseSeverity(CLEAN);
    assert.equal(s.decision, "CAN MERGE");
    assert.equal(s.blockingCount, 0);
    assert.equal(s.warningCount, 0);
  });

  it("distinguishes warnings-only from clean (CAN MERGE but warnings > 0)", () => {
    const s = parseSeverity(WARNINGS_ONLY);
    assert.equal(s.decision, "CAN MERGE");
    assert.equal(s.blockingCount, 0);
    assert.equal(s.warningCount, 2);
  });

  it("parses bilingual headings with emoji prefix", () => {
    const s = parseSeverity(ZH);
    assert.equal(s.decision, "CANNOT MERGE");
    assert.equal(s.blockingCount, 1);
    assert.equal(s.warningCount, 1);
  });

  it("flags fallback when no severity headings are present", () => {
    const s = parseSeverity(GARBAGE);
    assert.equal(s.fallback, true);
  });
});

describe("shouldFail", () => {
  const modes: FailMode[] = ["none", "blocking", "warning"];

  it("none never fails", () => {
    for (const m of modes) {
      const s = parseSeverity(WITH_BLOCKER);
      assert.equal(shouldFail(s, "none"), false);
    }
  });

  it("blocking fires on blockers, not on warnings-only", () => {
    assert.equal(shouldFail(parseSeverity(WITH_BLOCKER), "blocking"), true);
    assert.equal(shouldFail(parseSeverity(WARNINGS_ONLY), "blocking"), false);
    assert.equal(shouldFail(parseSeverity(CLEAN), "blocking"), false);
  });

  it("warning fires on warnings-only too (stricter than blocking)", () => {
    assert.equal(shouldFail(parseSeverity(WARNINGS_ONLY), "warning"), true);
    assert.equal(shouldFail(parseSeverity(WITH_BLOCKER), "warning"), true);
    assert.equal(shouldFail(parseSeverity(CLEAN), "warning"), false);
  });

  it("fails closed on fallback garbage whenever gate is armed", () => {
    assert.equal(shouldFail(parseSeverity(GARBAGE), "blocking"), true);
    assert.equal(shouldFail(parseSeverity(GARBAGE), "warning"), true);
    assert.equal(shouldFail(parseSeverity(GARBAGE), "none"), false);
  });
});

describe("withFailedReviewerOverride", () => {
  it("is a no-op when no reviewers failed", () => {
    const s = parseSeverity(CLEAN);
    assert.equal(withFailedReviewerOverride(s, []), s);
  });

  it("forces CANNOT MERGE and at least one blocking when a reviewer failed", () => {
    const s = withFailedReviewerOverride(parseSeverity(CLEAN), ["security"]);
    assert.equal(s.decision, "CANNOT MERGE");
    assert.ok(s.blockingCount >= 1);
    assert.equal(s.fallback, false);
  });
});
