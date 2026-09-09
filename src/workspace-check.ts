/**
 * Stale-tree guard (#67): fail closed when the workspace provably does not
 * contain the PR head tree, instead of silently reviewing a stale one.
 *
 * The reviewer read/grep tools, the related-context import graph, and the
 * verifier's disk checks all run against `cwd` — the caller's checkout. When
 * that tree is stale (typically a self-hosted runner whose workspace still
 * holds the PREVIOUS job's checkout because the review workflow has no
 * `actions/checkout` step), reviewers happily grep the old tree and report
 * findings about code the PR already fixed, and the verifier demotes them
 * with "file not found on disk" — after the verdict was already computed
 * from those stale facts. Issue #67 documents the full chain on
 * review-server-neo PR #15.
 *
 * Detection: a diff section marked `new file mode <mode>` describes a file
 * that MUST exist in any correct checkout of the PR head (a merge-commit
 * checkout contains it too). If any such file is missing under `cwd`, the
 * tree is provably not the PR head → the caller should abort with guidance.
 * Modified/deleted/renamed files cannot be checked this way (their existence
 * doesn't distinguish base from head), so the guard is intentionally
 * partial: it catches the common, provable case and stays silent otherwise.
 *
 * Best-effort fs checks: `access` errors count as "missing" rather than
 * throwing, mirroring the verifier's fail-open file-existence cache.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseDiffPath } from "./diff-path.js";

/** Outcome of the stale-tree check. */
export interface WorkspaceCheckResult {
  /** False → cwd provably lacks at least one file the PR adds. */
  ok: boolean;
  /** Files the diff adds that are missing under cwd (empty when ok). */
  missing: string[];
}

/** List the b-side paths of every diff section marked `new file mode`. */
export function parseAddedFiles(diff: string): string[] {
  const files: string[] = [];
  if (!diff) return files;
  // Same section split as changed-lines.ts: break on each `diff --git `.
  for (const section of diff.split(/(?=^diff --git )/m)) {
    // `new file mode 100644/100755` marks an addition; bare `new mode ...`
    // (permission-only change) must not match, hence the literal `file`.
    if (!/^new file mode \d+\r?$/m.test(section)) continue;
    const newlineIdx = section.indexOf("\n");
    const header = newlineIdx >= 0 ? section.slice(0, newlineIdx) : section;
    const filePath = parseDiffPath(header);
    if (filePath) files.push(filePath);
  }
  return files;
}

/** Check that every file the diff adds exists under cwd. Never throws. */
export async function checkWorkspace(diff: string, cwd: string): Promise<WorkspaceCheckResult> {
  const missing: string[] = [];
  // Deliberately collects the FULL missing list instead of short-circuiting
  // on the first hit (dogfood review of #68 asked): fs.access is a
  // microsecond-scale syscall, and enumerating every stale file gives the
  // error message diagnostic value a single name wouldn't — a reviewer can
  // see the whole scope of the workspace/tree mismatch at a glance.
  for (const file of parseAddedFiles(diff)) {
    try {
      await fs.access(path.resolve(cwd, file));
    } catch {
      missing.push(file);
    }
  }
  return { ok: missing.length === 0, missing };
}
