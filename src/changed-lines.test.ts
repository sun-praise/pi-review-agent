import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseChangedLines, listDiffFiles } from "./changed-lines.js";

/** A single-file diff with context, add, and remove lines. */
const MIXED_DIFF = [
  "diff --git a/src/foo.ts b/src/foo.ts",
  "index 111..222 100644",
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -1,3 +1,4 @@",
  " ctx1",          // context: old 1, new 1
  "-old2",          // removed: old 2
  " ctx3",          // context: old 3, new 2
  "+new4",          // added: new 3
  "+new5",          // added: new 4
].join("\n");

const PURE_ADD = [
  "diff --git a/new.ts b/new.ts",
  "--- a/new.ts",
  "+++ b/new.ts",
  "@@ -0,0 +1,2 @@",
  "+a",             // new 1
  "+b",             // new 2
].join("\n");

const PURE_DELETE = [
  "diff --git a/gone.ts b/gone.ts",
  "--- a/gone.ts",
  "+++ b/gone.ts",
  "@@ -1,2 +0,0 @@",
  "-x",             // old 1
  "-y",             // old 2
].join("\n");

describe("parseChangedLines", () => {
  it("returns empty map for empty diff", () => {
    assert.equal(parseChangedLines("").size, 0);
  });

  it("classifies context/added/removed lines into left and right", () => {
    const m = parseChangedLines(MIXED_DIFF);
    const e = m.get("src/foo.ts");
    assert.ok(e, "expected entry for src/foo.ts");
    // Removed lines: old 2.
    assert.deepEqual([...e.left].sort((a, b) => a - b), [2]);
    // Right (added + context): new lines for ctx1, ctx3, new4, new5 = 1,2,3,4.
    assert.deepEqual([...e.right].sort((a, b) => a - b), [1, 2, 3, 4]);
  });

  it("handles pure addition (oldLen 0)", () => {
    const m = parseChangedLines(PURE_ADD);
    const e = m.get("new.ts");
    assert.ok(e);
    assert.equal(e.left.size, 0);
    assert.deepEqual([...e.right].sort((a, b) => a - b), [1, 2]);
  });

  it("handles pure deletion (newLen 0)", () => {
    const m = parseChangedLines(PURE_DELETE);
    const e = m.get("gone.ts");
    assert.ok(e);
    assert.deepEqual([...e.left].sort((a, b) => a - b), [1, 2]);
    assert.equal(e.right.size, 0);
  });

  it("defaults omitted hunk length to 1", () => {
    const d = [
      "diff --git a/m b/m",
      "--- a/m",
      "+++ b/m",
      "@@ -1 +1 @@",   // lengths omitted → default 1
      " ctx",           // old 1, new 1
      "+add",           // new 2
    ].join("\n");
    const e = parseChangedLines(d).get("m");
    assert.ok(e);
    assert.deepEqual([...e.right].sort((a, b) => a - b), [1, 2]);
    assert.equal(e.left.size, 0);
  });

  it("handles multiple hunks in one file (counter resets per hunk)", () => {
    const d = [
      "diff --git a/m b/m",
      "--- a/m",
      "+++ b/m",
      "@@ -1,1 +1,1 @@",
      "-a",             // old 1
      "+A",             // new 1
      "@@ -10,1 +20,1 @@",
      "-b",             // old 10
      "+B",             // new 20
    ].join("\n");
    const e = parseChangedLines(d).get("m");
    assert.ok(e);
    assert.deepEqual([...e.left].sort((a, b) => a - b), [1, 10]);
    assert.deepEqual([...e.right].sort((a, b) => a - b), [1, 20]);
  });

  it("handles multiple files independently", () => {
    const d = MIXED_DIFF + "\n" + PURE_ADD;
    const m = parseChangedLines(d);
    assert.ok(m.get("src/foo.ts"));
    assert.ok(m.get("new.ts"));
    assert.equal(m.size, 2);
  });

  it("skips 'No newline at end of file' markers without advancing counters", () => {
    const d = [
      "diff --git a/m b/m",
      "--- a/m",
      "+++ b/m",
      "@@ -1,1 +1,2 @@",
      " keep",                          // old 1, new 1
      "+add",                           // new 2
      "\\ No newline at end of file",   // marker — ignored
    ].join("\n");
    const e = parseChangedLines(d).get("m");
    assert.ok(e);
    assert.deepEqual([...e.right].sort((a, b) => a - b), [1, 2]);
  });

  it("includes context lines in the right set (GitHub accepts comments on them)", () => {
    const d = [
      "diff --git a/m b/m",
      "--- a/m",
      "+++ b/m",
      "@@ -5,1 +5,1 @@",
      " unchanged",   // context at new line 5 — a comment pinned here is valid
    ].join("\n");
    const e = parseChangedLines(d).get("m");
    assert.ok(e);
    assert.ok(e.right.has(5), "context line should be in right set");
  });

  it("treats a real blank context line (space-prefixed) as a valid right anchor", () => {
    // A blank line in the file shows up in a diff as " " (space + nothing).
    const d = [
      "diff --git a/m b/m",
      "--- a/m",
      "+++ b/m",
      "@@ -1,2 +1,2 @@",
      " ",             // blank context line: old 1, new 1
      "-old",          // removed: old 2
      "+new",          // added: new 2
    ].join("\n");
    const e = parseChangedLines(d).get("m");
    assert.ok(e);
    assert.ok(e.right.has(1), "blank context line should anchor right side at line 1");
    assert.ok(e.right.has(2));
    assert.deepEqual([...e.left], [2]);
  });

  it("does not add a phantom line from the trailing empty string of split()", () => {
    // split("\n") yields a trailing "" after the last real line. That must NOT
    // be treated as a context line, or it'd add a bogus line number to the set.
    const d = [
      "diff --git a/m b/m",
      "--- a/m",
      "+++ b/m",
      "@@ -1,1 +1,1 @@",
      "+only",         // added: new 1 — then split produces a trailing ""
    ].join("\n");
    const e = parseChangedLines(d).get("m");
    assert.ok(e);
    assert.deepEqual([...e.right], [1], "trailing empty string must not add line 2");
  });

  it("produces no entry for a file whose section has no hunks (binary/rename)", () => {
    const d = [
      "diff --git a/binary.bin b/binary.bin",
      "Binary files differ",
    ].join("\n");
    assert.equal(parseChangedLines(d).size, 0);
  });

  it("keys the map by the full path when the path contains spaces (#25)", () => {
    const d = [
      "diff --git a/src/foo bar.ts b/src/foo bar.ts",
      "--- a/src/foo bar.ts",
      "+++ b/src/foo bar.ts",
      "@@ -1,1 +1,2 @@",
      " ctx",          // context: new 1
      "+new",          // added: new 2
    ].join("\n");
    const m = parseChangedLines(d);
    // The full "src/foo bar.ts" must be the key — not the truncated "src/foo".
    assert.ok(m.get("src/foo bar.ts"), "expected entry keyed by full spaced path");
    assert.equal(m.get("src/foo"), undefined, "must not truncate at the space");
    const e = m.get("src/foo bar.ts");
    assert.ok(e);
    assert.deepEqual([...e.right].sort((a, b) => a - b), [1, 2]);
  });

  it("keys the map by the full path for git's quoted header form (#25)", () => {
    const d = [
      'diff --git "a/src/foo bar.ts" "b/src/foo bar.ts"',
      "--- a/src/foo bar.ts",
      "+++ b/src/foo bar.ts",
      "@@ -1,1 +1,1 @@",
      "+x",
    ].join("\n");
    const m = parseChangedLines(d);
    assert.ok(m.get("src/foo bar.ts"), "quoted header must yield the spaced path");
  });
});

describe("listDiffFiles", () => {
  it("returns all file paths from diff headers", () => {
    const d = [
      "diff --git a/package.json b/package.json",
      "--- a/package.json",
      "+++ b/package.json",
      "@@ -1 +1 @@",
      '-"old"',
      '+"new"',
      "diff --git a/src/foo.ts b/src/foo.ts",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");
    assert.deepEqual(listDiffFiles(d), ["package.json", "src/foo.ts"]);
  });

  it("returns [] for empty diff", () => {
    assert.deepEqual(listDiffFiles(""), []);
  });

  it("includes binary/rename-only sections (no hunks)", () => {
    const d = [
      "diff --git a/binary.bin b/binary.bin",
      "Binary files differ",
    ].join("\n");
    assert.deepEqual(listDiffFiles(d), ["binary.bin"]);
  });
});
