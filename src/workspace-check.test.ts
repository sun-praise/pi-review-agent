import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseAddedFiles, checkWorkspace } from "./workspace-check.js";

/** The #67 shape: PR adds a file the stale workspace doesn't have. */
const NEW_FILE_DIFF = [
  "diff --git a/internal/store/stats_day_test.go b/internal/store/stats_day_test.go",
  "new file mode 100644",
  "index 0000000..1111111",
  "--- /dev/null",
  "+++ b/internal/store/stats_day_test.go",
  "@@ -0,0 +1,2 @@",
  "+package store",
  "+// test",
].join("\n");

const MODIFIED_FILE_DIFF = [
  "diff --git a/src/ui.go b/src/ui.go",
  "index 111..222 100644",
  "--- a/src/ui.go",
  "+++ b/src/ui.go",
  "@@ -1,2 +1,3 @@",
  " ctx",
  "+added",
].join("\n");

const DELETED_FILE_DIFF = [
  "diff --git a/gone.ts b/gone.ts",
  "deleted file mode 100644",
  "index 111..000",
  "--- a/gone.ts",
  "+++ /dev/null",
  "@@ -1,1 +0,0 @@",
  "-x",
].join("\n");

/** Binary additions carry the marker but no hunks — still an added file. */
const BINARY_NEW_FILE_DIFF = [
  'diff --git a/logo.png b/logo.png',
  "new file mode 100644",
  "index 0000000..1111111",
  "Binary files /dev/null and b/logo.png differ",
].join("\n");

const MIXED_DIFF = [NEW_FILE_DIFF, MODIFIED_FILE_DIFF, DELETED_FILE_DIFF].join("\n");

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "pi-review-workspace-"));
}

describe("parseAddedFiles", () => {
  it("returns only new-file sections from a mixed diff", () => {
    assert.deepEqual(parseAddedFiles(MIXED_DIFF), ["internal/store/stats_day_test.go"]);
  });

  it("captures binary new files (marker without hunks)", () => {
    assert.deepEqual(parseAddedFiles(BINARY_NEW_FILE_DIFF), ["logo.png"]);
  });

  it("returns [] for empty diff and diff without additions", () => {
    assert.deepEqual(parseAddedFiles(""), []);
    assert.deepEqual(parseAddedFiles(MODIFIED_FILE_DIFF), []);
    assert.deepEqual(parseAddedFiles(DELETED_FILE_DIFF), []);
  });

  it("parses quoted paths containing spaces", () => {
    const quoted = [
      'diff --git "a/src/foo bar.ts" "b/src/foo bar.ts"',
      "new file mode 100644",
      "--- /dev/null",
      '+++ "b/src/foo bar.ts"',
      "@@ -0,0 +1 @@",
      "+x",
    ].join("\n");
    assert.deepEqual(parseAddedFiles(quoted), ["src/foo bar.ts"]);
  });

  it("ignores permission-only mode changes (new mode, not new file mode)", () => {
    const modeOnly = [
      "diff --git a/run.sh b/run.sh",
      "old mode 100644",
      "new mode 100755",
    ].join("\n");
    assert.deepEqual(parseAddedFiles(modeOnly), []);
  });
});

describe("checkWorkspace", () => {
  it("ok when every added file exists under cwd", async () => {
    const dir = await makeTmpDir();
    try {
      await fs.mkdir(path.join(dir, "internal", "store"), { recursive: true });
      await fs.writeFile(path.join(dir, "internal", "store", "stats_day_test.go"), "x");
      const r = await checkWorkspace(NEW_FILE_DIFF, dir);
      assert.equal(r.ok, true);
      assert.deepEqual(r.missing, []);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("not ok, lists the file, when an added file is missing (the #67 case)", async () => {
    const dir = await makeTmpDir();
    try {
      const r = await checkWorkspace(NEW_FILE_DIFF, dir);
      assert.equal(r.ok, false);
      assert.deepEqual(r.missing, ["internal/store/stats_day_test.go"]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("ok for diffs with no additions, even when modified files are absent", async () => {
    const dir = await makeTmpDir();
    try {
      // Modified and deleted files are not existence-checked: base and head
      // both contain (or both lack) them, so absence proves nothing.
      const r = await checkWorkspace([MODIFIED_FILE_DIFF, DELETED_FILE_DIFF].join("\n"), dir);
      assert.equal(r.ok, true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("ok on an empty diff regardless of cwd contents", async () => {
    const r = await checkWorkspace("", os.tmpdir());
    assert.equal(r.ok, true);
    assert.deepEqual(r.missing, []);
  });

  it("end-to-end: a quoted path with spaces resolves and verifies on disk", async () => {
    // Regression guard (dogfood review of #68): parseDiffPath must hand
    // checkWorkspace the UNQUOTED b-side path; if a future regression let
    // the quotes through, fs.access would probe `"src/foo bar.ts"` (with
    // quotes) and every spaced path would false-positive as missing.
    const dir = await makeTmpDir();
    try {
      await fs.mkdir(path.join(dir, "src"), { recursive: true });
      await fs.writeFile(path.join(dir, "src", "foo bar.ts"), "x");
      const quoted = [
        'diff --git "a/src/foo bar.ts" "b/src/foo bar.ts"',
        "new file mode 100644",
        "--- /dev/null",
        '+++ "b/src/foo bar.ts"',
        "@@ -0,0 +1 @@",
        "+x",
      ].join("\n");
      const r = await checkWorkspace(quoted, dir);
      assert.equal(r.ok, true);
      assert.deepEqual(r.missing, []);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
