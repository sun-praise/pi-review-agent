/**
 * Compute the delta diff between the last reviewed commit and the current PR
 * head — the review payload for incremental runs.
 *
 * Primary path is git: `git diff <prev> <head>` reads ONLY the object
 * database, never the working tree, so a stale checkout cannot skew the
 * delta. Runners check out with depth 1, so the previous head usually isn't
 * local yet — missing commits are fetched from `origin` by SHA first, with
 * FULL history (no --depth, no --filter): the ancestry gate below has to
 * walk the commit chain between the two SHAs, a fetch into a shallow clone
 * still brings the complete chain for the requested SHAs, and a promisor
 * (partial) clone would leave later diffs dependent on lazy blob fetches
 * against runner credentials. GitHub enables SHA wants; Gitea depends on
 * server config.
 *
 * Ancestry gate: if `prev` is NOT an ancestor of `head` (rebase, force
 * push), the two-dot diff would present the whole fork-point divergence as
 * "new changes" and the compare fallback (three-dot from the merge base)
 * would silently MISS the reverted/replayed commits — both semantics are
 * wrong for "what changed since the last review". Non-ancestor therefore
 * returns `{ error: "non-ancestor" }` WITHOUT the compare fallback, and the
 * caller runs a full review.
 *
 * Other git failures (no repo, unreachable origin, SHA wants disabled) fall
 * through to the compare fallback, and failing that the caller falls back to
 * the full-diff review: incremental is an optimization and must never fail a
 * run (fail-open, like every other optional layer in this agent).
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
   *  when unsupported (Gitea) or failed. Only reached when git itself could
   *  not produce a delta — never for a non-ancestor pair (see above). */
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

/** Result of a delta attempt. `diff` is the unified diff ("" = a valid
 *  empty delta). `error` says why no delta could be produced — the caller
 *  distinguishes the DELIBERATE bail (non-ancestor pair) from tool failures
 *  ("unavailable", which includes an exhausted compare fallback). */
export type DeltaResult =
  | { diff: string; error?: undefined }
  | { diff?: undefined; error: "non-ancestor" }
  | { diff?: undefined; error: "unavailable" };

/**
 * Delta diff between two commits, or an error outcome when neither git nor
 * the compare fallback could produce one. An empty-string diff is a valid
 * delta ("no changes since the anchor").
 */
export async function computeDeltaDiff(
  prev: string,
  head: string,
  cwd: string,
  deps: DeltaDiffDeps = {},
): Promise<DeltaResult> {
  const unavailable: DeltaResult = { error: "unavailable" };
  if (!SHA_RE.test(prev) || !SHA_RE.test(head)) return unavailable;
  const runGit = deps.runGit ?? defaultRunGit;
  const timeoutMs = deps.timeoutMs ?? 60_000;
  const compare = async (): Promise<DeltaResult> => {
    if (!deps.fetchCompare) return unavailable;
    const viaApi = await deps.fetchCompare(prev, head);
    return viaApi === null ? unavailable : { diff: viaApi };
  };

  const hasCommit = async (sha: string): Promise<boolean> =>
    (await runGit(["cat-file", "-e", `${sha}^{commit}`], cwd, timeoutMs)).code === 0;

  // A usable repo must exist (runners without a checkout step, bare dirs).
  if ((await runGit(["rev-parse", "--git-dir"], cwd, timeoutMs)).code !== 0) {
    return compare();
  }
  // Depth-1 checkouts don't carry the anchor commit; fetch both SHAs from
  // origin with full history (see the module comment for why no --depth /
  // --filter). A failure here (no origin, SHA wants disabled) exits to the
  // compare fallback.
  if (!(await hasCommit(prev)) || !(await hasCommit(head))) {
    const fetched = await runGit(["fetch", "--no-tags", "origin", prev, head], cwd, timeoutMs);
    if (fetched.code !== 0) return compare();
    if (!(await hasCommit(prev)) || !(await hasCommit(head))) return compare();
  }
  // Ancestry gate: exit 0 = ancestor (safe two-dot delta), exit 1 = NOT an
  // ancestor (rebase/force-push) → deliberate bail, skipping the compare
  // fallback (three-dot diff would silently miss reverted commits). Any
  // other exit is a git error → compare fallback.
  const ancestry = await runGit(["merge-base", "--is-ancestor", prev, head], cwd, timeoutMs);
  if (ancestry.code === 1) return { error: "non-ancestor" };
  if (ancestry.code !== 0) return compare();
  const diff = await runGit(
    ["diff", "--no-color", "--no-textconv", "--no-ext-diff", prev, head],
    cwd,
    timeoutMs,
  );
  if (diff.code !== 0) return compare();
  return { diff: diff.stdout };
}
