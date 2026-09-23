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

  it("decodes octal escapes in a quoted non-ASCII path (the #74 regression)", () => {
    // git's core.quotepath (and `gh pr diff` / the GitHub .diff API) escapes
    // every non-ASCII byte as 3-digit octal inside quotes. Undecoded, the
    // path can never match the on-disk UTF-8 name.
    const header =
      'diff --git "a/content/post/2026-09-23-omp-\\347\\232\\204-skill-\\345\\212\\240\\350\\275\\275\\346\\234\\272\\345\\210\\266/index.md" ' +
      '"b/content/post/2026-09-23-omp-\\347\\232\\204-skill-\\345\\212\\240\\350\\275\\275\\346\\234\\272\\345\\210\\266/index.md"';
    assert.equal(
      parseDiffPath(header),
      "content/post/2026-09-23-omp-的-skill-加载机制/index.md",
    );
  });

  it("decodes escaped quote and backslash in a quoted path", () => {
    assert.equal(
      parseDiffPath('diff --git "a/we \\"ird\\\\dir/f.ts" "b/we \\"ird\\\\dir/f.ts"'),
      'we "ird\\dir/f.ts',
    );
  });

  it("keeps a lone backslash literal in a quoted path", () => {
    // git emits `\\` for a real backslash, so a lone `\` is not its output —
    // but if one slips through, dropping it would corrupt the name.
    assert.equal(
      parseDiffPath('diff --git "a/src/w\\x.ts" "b/src/w\\x.ts"'),
      "src/w\\x.ts",
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
