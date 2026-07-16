import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDiffPath } from "./diff-path.js";

describe("parseDiffPath", () => {
  it("parses a simple unquoted path", () => {
    assert.equal(parseDiffPath("diff --git a/src/foo.ts b/src/foo.ts"), "src/foo.ts");
  });

  it("parses an unquoted path containing spaces (the #25 regression)", () => {
    assert.equal(
      parseDiffPath("diff --git a/src/foo bar.ts b/src/foo bar.ts"),
      "src/foo bar.ts",
    );
  });

  it("parses a quoted path containing spaces", () => {
    assert.equal(
      parseDiffPath('diff --git "a/src/foo bar.ts" "b/src/foo bar.ts"'),
      "src/foo bar.ts",
    );
  });

  it("anchors b/ via the quoted form when the path contains ' b/'", () => {
    // Unquoted, this header is genuinely ambiguous (is " b/" a separator or
    // part of the path?). Git resolves it by quoting; our quoted branch uses
    // the closing quote as the hard boundary, so the inner " b/" is preserved.
    assert.equal(
      parseDiffPath('diff --git "a/docs/old b/notes.md" "b/docs/old b/notes.md"'),
      "docs/old b/notes.md",
    );
  });

  it("tolerates a trailing CR (CRLF diff)", () => {
    assert.equal(
      parseDiffPath("diff --git a/src/foo bar.ts b/src/foo bar.ts\r"),
      "src/foo bar.ts",
    );
  });

  it("returns null for a non-diff line", () => {
    assert.equal(parseDiffPath("index 111..222 100644"), null);
    assert.equal(parseDiffPath(""), null);
  });
});
