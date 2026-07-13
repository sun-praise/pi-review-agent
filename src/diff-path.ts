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
 *      misread (spaces, leading `-`, special chars):
 *        diff --git "a/src/foo bar.ts" "b/src/foo bar.ts"
 *      The quotes bound each side precisely, so the path is taken verbatim
 *      from inside the `"b/..."` segment (git has already escaped anything
 *      tricky within the quotes).
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

/** Parse a `diff --git` header line, returning the b-side path, or null. */
export function parseDiffPath(header: string): string | null {
  // Quoted form: `diff --git "a/..." "b/..."`. Bound each side by its quotes;
  // greedy `.*` would run past the closing quote of the a-side into the b-side.
  const quoted = header.match(/^diff --git "a\/[^"]*" "b\/(.+)"/);
  if (quoted) return quoted[1];

  // Unquoted form: `diff --git a/... b/...`. Greedy `.*` anchors `b/` at the
  // last ` b/`; non-greedy capture + `\r?$` keeps trailing whitespace out.
  const unquoted = header.match(/^diff --git a\/.* b\/(.+?)\r?$/);
  return unquoted ? unquoted[1] : null;
}
