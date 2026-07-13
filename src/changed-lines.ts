/**
 * Parse a unified diff into per-file changed-line sets, keyed by file path.
 *
 * Used by the verifier's rule layer (verifier.ts): after the coordinator pins
 * a finding to `{file, line, side}`, we check whether that line was actually
 * touched in the diff. A finding pointing at a line the PR didn't change is a
 * hallucination (or a stale line number) and gets demoted.
 *
 * Side semantics mirror the GitHub Reviews API + inline-comments.ts:
 *   - `left`  = removed lines (old file line numbers) → comment.side "LEFT"
 *   - `right` = added AND context lines (new file line numbers) → "RIGHT"
 * GitHub accepts inline comments on added or context lines (not just pure
 * additions), so the `right` set includes ` ` (context) lines within hunks.
 * `left` is strictly removed (`-`) lines.
 *
 * Pure: no fs, no side effects. Section splitting + path extraction mirror
 * diff-filter.ts; the hunk-range walk is new (diff-filter discards @@ headers).
 *
 * Unified-diff hunk header grammar: `@@ -oldStart[,oldLen] +newStart[,newLen] @@`.
 * When the length is omitted it defaults to 1. `oldLen === 0` means a hunk
 * that is purely added (no old lines) — oldStart then points at the line AFTER
 * which insertions happen, so old lines start at oldStart+1 (none to walk).
 * Same for newLen === 0 on a pure deletion.
 */

/** Changed-line sets for one file. */
export interface ChangedLines {
  /** Old-file line numbers of removed lines (`-`). Maps to side "LEFT". */
  left: Set<number>;
  /** New-file line numbers of added AND context lines (`+` and ` `). Maps to
   *  side "RIGHT". Context lines are included because GitHub's Reviews API
   *  accepts inline comments on them, not only on pure additions. */
  right: Set<number>;
}

/** Parse a unified diff into a Map<filePath, ChangedLines>. */
export function parseChangedLines(diff: string): Map<string, ChangedLines> {
  const result = new Map<string, ChangedLines>();
  if (!diff) return result;

  // Same section split as filterDiff: break on each "diff --git " boundary.
  const sections = diff.split(/(?=^diff --git )/m);
  for (const section of sections) {
    if (!section) continue;
    const newlineIdx = section.indexOf("\n");
    const header = newlineIdx >= 0 ? section.slice(0, newlineIdx) : section;
    const filePath = parseDiffPath(header);
    if (!filePath) continue;

    const lines = section.split("\n");
    // First line is the header; hunk parsing walks the rest.
    let oldLine = 0;
    let newLine = 0;
    let inHunk = false;
    // Accumulate into a per-file map entry lazily so files with no hunks
    // (e.g. binary, rename-only) don't get an empty entry.
    let entry: ChangedLines | undefined;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      // Hunk header: @@ -oldStart[,oldLen] +newStart[,newLen] @@
      const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (hunk) {
        const oldStart = Number(hunk[1]);
        const oldLen = hunk[2] !== undefined ? Number(hunk[2]) : 1;
        const newStart = Number(hunk[3]);
        const newLen = hunk[4] !== undefined ? Number(hunk[4]) : 1;
        // len === 0 → insertion/deletion point. The "start" then points at the
        // line *after* which changes occur; there are no lines on that side to
        // walk, so start counters sit just past it and the walk skips them.
        oldLine = oldLen === 0 ? oldStart + 1 : oldStart;
        newLine = newLen === 0 ? newStart + 1 : newStart;
        inHunk = true;
        continue;
      }
      if (!inHunk) continue;
      // A "No newline at end of file" marker has no +/-/space prefix and is
      // not a content line; skip it without advancing counters.
      if (line.startsWith("\\ No newline at end of file")) continue;

      if (line.startsWith("+")) {
        entry ??= ensureEntry(result, filePath);
        entry.right.add(newLine);
        newLine++;
      } else if (line.startsWith("-")) {
        entry ??= ensureEntry(result, filePath);
        entry.left.add(oldLine);
        oldLine++;
      } else if (line.startsWith(" ")) {
        // Context line: advances both counters, and counts as a valid anchor
        // for the right side (GitHub accepts inline comments on context lines).
        entry ??= ensureEntry(result, filePath);
        entry.right.add(newLine);
        oldLine++;
        newLine++;
      }
      // Any other line (including the trailing "" from split(), or an empty
      // string with no space prefix) is not valid diff content — skip without
      // advancing, so counters stay aligned for the next real content line.
      // Lines inside a hunk that don't start with +, -, space are not valid
      // diff content (e.g. a stray "\ No newline..." already handled above);
      // ignore them without advancing.
    }
  }
  return result;
}

/** Parse a "diff --git a/<path> b/<path>" header, return the b-side path. */
function parseDiffPath(header: string): string | null {
  const m = header.match(/^diff --git a\/.* b\/(.+?)(?:\s|$)/);
  return m ? m[1] : null;
}

function ensureEntry(map: Map<string, ChangedLines>, path: string): ChangedLines {
  let e = map.get(path);
  if (!e) {
    e = { left: new Set(), right: new Set() };
    map.set(path, e);
  }
  return e;
}
