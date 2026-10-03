import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSeverity, shouldFail, withFailedReviewerOverride } from "./severity.js";

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

// Repro of the PR #85 dogfood incident (run 37086811185): the coordinator
// followed the prompt literally — bare section-name lines, no `###` — and
// the then-parser saw "no recognizable sections" → fallback → fail-closed
// exit 1 while the PR comment said ✅ CAN MERGE.
const BARE_HEADINGS = [
  "CAN MERGE",
  "",
  "三位评审一致给出 CAN MERGE，未发现任何阻塞性问题。",
  "",
  "Blocking Issues",
  "",
  "（无）",
  "",
  "Warnings",
  "",
  "- skip 路径不写 GITHUB_OUTPUT",
  "- intEnv 接受非整数",
  "- 并发 read-modify-write 会少计",
  "",
  "Suggestions",
  "",
  "- 为 json 模式补结构化 skip 输出",
].join("\n");

// The persona prompt's single-line empty form ('Blocking Issues: None')
// followed by a colon-headed warnings list.
const COLON_HEADINGS = [
  "CAN MERGE",
  "",
  "Looks fine overall.",
  "",
  "Blocking Issues: None",
  "Warnings:",
  "- Naming is inconsistent",
  "- Add a comment",
].join("\n");

const BOLD_HEADINGS = [
  "CONDITIONAL MERGE",
  "",
  "**Blocking Issues**",
  "1. stale-tree fact",
  "",
  "**Warnings**",
  "- verbose logging",
].join("\n");

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

  it("parses bare section-name headings (PR #85 dogfood coordinator shape)", () => {
    const s = parseSeverity(BARE_HEADINGS);
    assert.equal(s.decision, "CAN MERGE");
    assert.equal(s.fallback, false);
    assert.equal(s.blockingCount, 0);
    assert.equal(s.warningCount, 3);
  });

  it("parses colon-headed sections and the prompt's 'X: None' single-line form", () => {
    const s = parseSeverity(COLON_HEADINGS);
    assert.equal(s.fallback, false);
    assert.equal(s.blockingCount, 0);
    assert.equal(s.warningCount, 2);
  });

  it("parses bold headings; a bare next-section line does not leak items across buckets", () => {
    const s = parseSeverity(BOLD_HEADINGS);
    assert.equal(s.decision, "CONDITIONAL MERGE");
    assert.equal(s.fallback, false);
    assert.equal(s.blockingCount, 1);
    assert.equal(s.warningCount, 1);
  });

  it("prose mentioning a section keyword is not a heading (fallback stays armed)", () => {
    const s = parseSeverity(["CAN MERGE", "", "Warnings are listed in the table above.", "Blocking issues: see previous review."].join("\n"));
    assert.equal(s.fallback, true);
  });
});

describe("shouldFail", () => {
  it("none never fails, regardless of severity", () => {
    assert.equal(shouldFail(parseSeverity(WITH_BLOCKER), "none"), false);
    assert.equal(shouldFail(parseSeverity(WARNINGS_ONLY), "none"), false);
    assert.equal(shouldFail(parseSeverity(CLEAN), "none"), false);
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
