import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { filterDiff } from "./diff-filter.js";

const LOCK_DIFF = [
  "diff --git a/package.json b/package.json",
  "index 111..222 100644",
  "--- a/package.json",
  "+++ b/package.json",
  "@@ -1 +1 @@",
  "-\"old\"",
  "+\"new\"",
  "diff --git a/package-lock.json b/package-lock.json",
  "index 333..444 100644",
  "--- a/package-lock.json",
  "+++ b/package-lock.json",
  "@@ -1 +1 @@",
  "-huge",
  "+blob",
  "diff --git a/src/foo.ts b/src/foo.ts",
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
].join("\n");

describe("filterDiff", () => {
  it("strips lock files and keeps source", () => {
    const r = filterDiff(LOCK_DIFF);
    assert.equal(r.removedFiles.length, 1);
    assert.equal(r.removedFiles[0], "package-lock.json");
    assert.equal(r.truncated, false);
    assert.ok(r.filtered.includes("src/foo.ts"));
    assert.ok(!r.filtered.includes("package-lock.json"));
  });

  it("returns empty for empty input", () => {
    const r = filterDiff("");
    assert.deepEqual(r, { filtered: "", removedFiles: [], truncated: false, filteredBytes: 0 });
  });

  it("applies user excludePatterns by basename", () => {
    const r = filterDiff(LOCK_DIFF, { excludePatterns: ["foo.ts"] });
    assert.deepEqual(r.removedFiles.sort(), ["package-lock.json", "src/foo.ts"]);
  });

  it("applies user excludePatterns by full path with slash", () => {
    const r = filterDiff(LOCK_DIFF, { excludePatterns: ["src/**"] });
    assert.ok(r.removedFiles.includes("src/foo.ts"));
  });

  it("strips go.sum and Cargo.lock", () => {
    const d =
      "diff --git a/go.sum b/go.sum\n--- a/go.sum\n+++ b/go.sum\n+x\n" +
      "diff --git a/Cargo.lock b/Cargo.lock\n--- a/Cargo.lock\n+++ b/Cargo.lock\n+y\n" +
      "diff --git a/main.go b/main.go\n--- a/main.go\n+++ b/main.go\n+z\n";
    const r = filterDiff(d);
    assert.deepEqual(r.removedFiles.sort(), ["Cargo.lock", "go.sum"]);
    assert.ok(r.filtered.includes("main.go"));
  });

  it("truncates to byte budget keeping whole leading sections that fit", () => {
    // LOCK_DIFF has three sections; package-lock is stripped as a lock file,
    // so the kept set is [package.json (~127 B), src/foo.ts (~92 B)]. A budget
    // between the two sizes keeps the first and drops the second whole.
    const r = filterDiff(LOCK_DIFF, { maxSizeBytes: 160 });
    assert.equal(r.truncated, true);
    assert.ok(r.filtered.includes("[Diff truncated:"));
    assert.ok(r.filtered.includes("package.json"), "first kept section fits the budget");
    assert.ok(!r.filtered.includes("src/foo.ts"), "second kept section dropped (whole, not sliced)");
  });

  it("drops even the first section when it alone exceeds the budget (#28)", () => {
    // The pre-#28 bug unconditionally kept the first section regardless of
    // budget, so a single 13 MB dist/ section sailed past a 200 KB budget.
    // Now a section that doesn't fit is dropped whole — never sliced.
    const onlyFirst = filterDiff("diff --git a/x b/x\n--- a/x\n+++ b/x\n+yyyy\n", { maxSizeBytes: 1 });
    assert.ok(onlyFirst.truncated, "oversized diff is still flagged truncated");
    assert.ok(!onlyFirst.filtered.includes("diff --git a/x"), "oversized first section is NOT kept");
    assert.ok(onlyFirst.filtered.includes("[Diff truncated:"), "notice still appended");
  });

  it("leaves diff alone when under budget", () => {
    const r = filterDiff(LOCK_DIFF, { maxSizeBytes: 10_000 });
    assert.equal(r.truncated, false);
  });

  it("excludes build artifacts (dist/, build/, *.min.js) by default (#28)", () => {
    const d = [
      "diff --git a/dist/index.cjs b/dist/index.cjs",
      "--- a/dist/index.cjs",
      "+++ a/dist/index.cjs",
      "@@ -1 +1 @@",
      "-old bundle",
      "+new bundle",
      "diff --git a/app.min.js b/app.min.js",
      "--- a/app.min.js",
      "+++ b/app.min.js",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "diff --git a/src/index.ts b/src/index.ts",
      "--- a/src/index.ts",
      "+++ b/src/index.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");
    const r = filterDiff(d);
    assert.deepEqual(r.removedFiles.sort(), ["app.min.js", "dist/index.cjs"]);
    assert.ok(r.filtered.includes("src/index.ts"));
    assert.ok(!r.filtered.includes("dist/"));
    assert.ok(!r.filtered.includes("app.min.js"));
  });

  it("keeps build artifacts when includeBuildArtifacts is set (#28 escape hatch)", () => {
    const d = [
      "diff --git a/dist/index.cjs b/dist/index.cjs",
      "--- a/dist/index.cjs",
      "+++ a/dist/index.cjs",
      "@@ -1 +1 @@",
      "-x",
      "+y",
    ].join("\n");
    const r = filterDiff(d, { includeBuildArtifacts: true });
    assert.deepEqual(r.removedFiles, []);
    assert.ok(r.filtered.includes("dist/index.cjs"));
  });

  it("build-artifact exclusion + byte budget together defeat the #28 scenario", () => {
    // Mirror the real trigger: a huge dist/ section first, a small src change
    // second. The dist/ section is excluded outright (not counted toward the
    // budget), and the small src change survives — no 413, real change reviewed.
    const huge = "x".repeat(5000);
    const d = [
      "diff --git a/dist/index.cjs b/dist/index.cjs",
      "--- a/dist/index.cjs",
      "+++ a/dist/index.cjs",
      "@@ -1 +1 @@",
      "-" + huge,
      "+" + huge,
      "diff --git a/src/index.ts b/src/index.ts",
      "--- a/src/index.ts",
      "+++ b/src/index.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");
    // 200 KB budget (the real default). dist/ is 10 KB but excluded; src/ is tiny.
    const r = filterDiff(d, { maxSizeBytes: 200 * 1024 });
    assert.deepEqual(r.removedFiles, ["dist/index.cjs"]);
    assert.ok(r.filtered.includes("src/index.ts"));
    assert.equal(r.truncated, false, "src change alone is well under budget");
  });

  it("keeps a source file whose path contains spaces (#25)", () => {
    const d = [
      "diff --git a/src/foo bar.ts b/src/foo bar.ts",
      "--- a/src/foo bar.ts",
      "+++ b/src/foo bar.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");
    const r = filterDiff(d);
    assert.deepEqual(r.removedFiles, []);
    // The full spaced path must survive into the kept diff (not truncated to
    // "src/foo"), so the model sees the right file.
    assert.ok(r.filtered.includes("src/foo bar.ts"));
  });

  it("strips a lock file whose path contains spaces, via basename (#25)", () => {
    const d = [
      "diff --git a/pkg/dep cache.lock b/pkg/dep cache.lock",
      "--- a/pkg/dep cache.lock",
      "+++ b/pkg/dep cache.lock",
      "@@ -1 +1 @@",
      "-x",
      "+y",
    ].join("\n");
    const r = filterDiff(d);
    // Lock detection runs on the basename; a spaced lock file must still be
    // caught and reported by its full path.
    assert.deepEqual(r.removedFiles, ["pkg/dep cache.lock"]);
    assert.ok(!r.filtered.includes("dep cache.lock"));
  });
});
