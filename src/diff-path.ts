/**
 * Parse the b-side file path out of a `diff --git a/<path> b/<path>` header.
 *
 * Shared by `changed-lines.ts` and `diff-filter.ts` so the two consumers agree
 * on exactly what string is the file's identity. `changed-lines.ts` uses it as
 * the Map key that the verifier matches against `comment.file`; `diff-filter.ts`
 * uses it for lock/exclude matching and the user-facing `removedFiles` list.
 *
 * Git emits two header shapes:
 *   1. Quoted — when the path contains bytes git's pathspec would otherwise
 *      misread (spaces, leading `-`, special chars, non-ASCII):
 *        diff --git "a/src/foo bar.ts" "b/src/foo bar.ts"
 *        diff --git "a/src/om-\347\232\204-p/index.md" "b/src/om-\347\232\204-p/index.md"
 *      The quotes bound each side precisely, so the path is taken from inside
 *      the `"b/..."` segment, then C-style escapes are decoded: `\"`, `\\`,
 *      and 3-digit octal `\NNN` byte escapes (what git's core.quotepath — on
 *      by default, and what `gh pr diff` / the GitHub .diff API emit — does
 *      to every non-ASCII byte). Octal escapes are raw bytes, so they are
 *      collected into a byte buffer and decoded as UTF-8 at the end; leaving
 *      them undecoded makes every non-ASCII path mismatch the on-disk name
 *      (issue #74: the #67 stale-tree guard false-positived on a Chinese
 *      filename).
 *   2. Unquoted — the common case:
 *        diff --git a/src/foo bar.ts b/src/foo bar.ts
 *      There is no delimiter after the path, so it extends to end of line.
 *      The ` b/` separator is matched greedily to the LAST occurrence, which
 *      handles the ordinary spaced-path case correctly. A path that itself
 *      contains ` b/` is inherently ambiguous in the unquoted form, so git
 *      emits it quoted (case 1) — that is the authoritative input for such
 *      paths. A trailing `\r` is tolerated so CRLF diffs don't leak into the
 *      captured path.
 *
 * Pure: no fs, no side effects.
 */

/**
 * Decode git's C-style escapes inside a quoted diff path. `\"` and `\\` map
 * to their literal characters; `\NNN` (3 octal digits) is one raw byte. A
 * backslash anything else keeps literally — git never emits that, and a
 * filename may legitimately contain `\` via `\\`. Escaped bytes are gathered
 * into a buffer and decoded as UTF-8 once at the end, since an octal escape
 * is a single byte of a multi-byte character, not a character of its own.
 */
export function unquoteGitPath(path: string): string {
  if (!path.includes("\\")) return path;
  const bytes: number[] = [];
  for (let i = 0; i < path.length; i++) {
    const ch = path[i]!;
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf8"));
      continue;
    }
    const octal = path.slice(i + 1, i + 4).match(/^[0-7]{3}$/);
    if (octal) {
      bytes.push(parseInt(path.slice(i + 1, i + 4), 8));
      i += 3;
      continue;
    }
    const next = path[i + 1];
    if (next === '"' || next === "\\") {
      bytes.push(next.charCodeAt(0));
      i += 1;
      continue;
    }
    bytes.push(ch.charCodeAt(0));
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Parse a `diff --git` header line, returning the b-side path, or null. */
export function parseDiffPath(header: string): string | null {
  // Quoted form: `diff --git "a/..." "b/..."`. Bound each side by its quotes;
  // greedy `.*` would run past the closing quote of the a-side into the b-side.
  // The a-side needs `[^"\\]|\\.` (not `[^"]*`) so an escaped `\"` inside the
  // path doesn't end the segment early; the b-side's greedy `.+` then runs to
  // the line's closing quote. Escapes are decoded afterwards by unquoteGitPath.
  const quoted = header.match(/^diff --git "a\/(?:[^"\\]|\\.)*" "b\/(.+)"/);
  if (quoted) return unquoteGitPath(quoted[1]);

  // Unquoted form: `diff --git a/... b/...`. Greedy `.*` anchors `b/` at the
  // last ` b/`; non-greedy capture + `\r?$` keeps trailing whitespace out.
  const unquoted = header.match(/^diff --git a\/.* b\/(.+?)\r?$/);
  return unquoted ? unquoted[1] : null;
}
