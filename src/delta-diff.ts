/**
 * Compute the delta diff between the last reviewed commit and the current PR
 * head — the review payload for incremental runs.
 *
 * Primary path is git: `git diff <prev> <head>` reads ONLY the object
 * database, never the working tree, so a stale checkout cannot skew the
 * delta. Runners check out with depth 1, so the previous head usually isn't
 * local yet — missing commits are fetched from `origin` by SHA first
 * (GitHub enables SHA wants; Gitea depends on server config). If git can't
 * deliver (no repo, unreachable origin, SHA wants disabled), an injectable
 * platform compare API is tried, and failing that the caller falls back to
 * the full-diff review: incremental is an optimization and must never fail
 * a run (fail-open, like every other optional layer in this agent).
 *
 * The git runner is injectable so tests drive the decision tree without a
 * repository; the compare fallback is a plain async function for the same
 * reason.
 */
import { execFile } from "node:child_process";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type GitRunner = (args: string[], cwd: string, timeoutMs: number) => Promise<GitResult>;

export interface DeltaDiffDeps {
  runGit?: GitRunner;
  /** Platform compare fallback (GitHub REST, diff media type). Returns null
   *  when unsupported (Gitea) or failed. Note: GitHub's compare endpoint is
   *  three-dot (merge-base..head), so on a force-push its delta differs from
   *  the two-dot git path — acceptable for a fallback whose next stop is a
   *  full review anyway. */
  fetchCompare?: (base: string, head: string) => Promise<string | null>;
  /** Per-call timeout for git invocations. Default 60s. */
  timeoutMs?: number;
}

const SHA_RE = /^[0-9a-f]{7,40}$/i;

/** Real git runner. GIT_TERMINAL_PROMPT=0 so a credentials gap fails fast
 *  instead of hanging on an invisible prompt (self-hosted runners have no
 *  TTY; the job would sit until the step timeout). maxBuffer 64MB — large
 *  deltas must come back whole or not at all. */
const defaultRunGit: GitRunner = (args, cwd, timeoutMs) => {
  const { promise, resolve } = Promise.withResolvers<GitResult>();
  execFile(
    "git",
    ["-C", cwd, ...args],
    {
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    },
    (err, stdout, stderr) => {
      let code = 0;
      if (err) code = "code" in err && typeof err.code === "number" ? err.code : 1;
      resolve({ code, stdout, stderr });
    },
  );
  return promise;
};

/**
 * Delta diff between two commits, or null when neither git nor the compare
 * fallback could produce one. An empty-string return is a valid delta ("no
 * changes since the anchor") — callers distinguish it from null.
 */
export async function computeDeltaDiff(
  prev: string,
  head: string,
  cwd: string,
  deps: DeltaDiffDeps = {},
): Promise<string | null> {
  if (!SHA_RE.test(prev) || !SHA_RE.test(head)) return null;
  const runGit = deps.runGit ?? defaultRunGit;
  const timeoutMs = deps.timeoutMs ?? 60_000;

  const hasCommit = async (sha: string): Promise<boolean> =>
    (await runGit(["cat-file", "-e", `${sha}^{commit}`], cwd, timeoutMs)).code === 0;

  const fromGit = async (): Promise<string | null> => {
    // A usable repo must exist (runners without a checkout step, bare dirs).
    if ((await runGit(["rev-parse", "--git-dir"], cwd, timeoutMs)).code !== 0) return null;
    // Depth-1 checkouts don't carry the anchor commit; fetch both SHAs from
    // origin. A failure here (no origin, SHA wants disabled) exits to the
    // compare fallback.
    if (!(await hasCommit(prev)) || !(await hasCommit(head))) {
      const fetched = await runGit(["fetch", "--no-tags", "origin", prev, head], cwd, timeoutMs);
      if (fetched.code !== 0) return null;
      if (!(await hasCommit(prev)) || !(await hasCommit(head))) return null;
    }
    const diff = await runGit(
      ["diff", "--no-color", "--no-textconv", "--no-ext-diff", prev, head],
      cwd,
      timeoutMs,
    );
    return diff.code === 0 ? diff.stdout : null;
  };

  const delta = await fromGit();
  if (delta !== null) return delta;
  return deps.fetchCompare ? deps.fetchCompare(prev, head) : null;
}
