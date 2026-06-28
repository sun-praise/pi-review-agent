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

  it("truncates to byte budget keeping whole sections, first always kept", () => {
    // package-lock section is ~140 bytes; set budget below total but above
    // the smallest single section so at least the first is kept.
    const r = filterDiff(LOCK_DIFF, { maxSizeBytes: 80 });
    assert.equal(r.truncated, true);
    assert.ok(r.filtered.includes("[Diff truncated:"));
    // First section (package.json) must always survive even if oversized.
    const onlyFirst = filterDiff("diff --git a/x b/x\n--- a/x\n+++ b/x\n+yyyy\n", { maxSizeBytes: 1 });
    assert.ok(onlyFirst.truncated);
    assert.ok(onlyFirst.filtered.includes("diff --git a/x"));
  });

  it("leaves diff alone when under budget", () => {
    const r = filterDiff(LOCK_DIFF, { maxSizeBytes: 10_000 });
    assert.equal(r.truncated, false);
  });
});
