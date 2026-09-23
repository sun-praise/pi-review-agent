/**
 * Grep backend for the reviewer/verifier `grep` tool.
 *
 * Primary path shells out to git (same approach as alibaba/open-code-review):
 *
 *   git -c core.quotepath=false grep --no-color -n --relative --untracked \
 *       (-F | -P) -e <pattern> [-- :(glob)<glob>]
 *
 * The search range is defined by git itself: every tracked file (committed
 * build artifacts included) plus untracked files that are not gitignored.
 * The previous implementation walked the tree with a hardcoded IGNORE list
 * (dist/, build/, vendor/…), so in repositories that COMMIT their build
 * output — this one runs `node dist/index.cjs` from git — grep evidence
 * about the bundle was silently empty, and a reviewer turned "the tool
 * refused to look" into a confident "verified absent" blocking finding
 * (issue #76). `core.quotepath=false` reports non-ASCII paths literally
 * instead of octal-escaped, the #74 family: escaped paths can neither be
 * matched against on-disk names nor re-opened by the `read` tool.
 *
 * Non-git directories fall back to the legacy filesystem walker (with its
 * IGNORE list) — git grep exits 128 "not a git repository" there.
 *
 * Output shape is unchanged: `relative/path:line:text` per match, at most
 * `cap` match lines, each truncated to 200 chars. When results are cut, a
 * leading `Note:` line reports the true totals (all lines are counted, only
 * the rendering is capped) so the caller can tell "few matches" from
 * "truncated matches".
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

const execFileAsync = promisify(execFile);

const GIT_GREP_TIMEOUT_MS = 10_000;
const GIT_GREP_MAX_BUFFER = 32 * 1024 * 1024;
const LINE_RENDER_CAP = 200;

export async function walkGrep(
  cwd: string,
  pattern: string,
  glob: string | undefined,
  cap: number,
  literal?: boolean,
): Promise<string> {
  if (!pattern) return "";
  // Mirror the old safeRegex contract: an invalid regex yields no matches
  // instead of an error. Only meaningful for the git -P path, but checked
  // here so both backends agree.
  if (!literal && !safeRegex(pattern)) return "";
  try {
    return await gitGrep(cwd, pattern, glob, cap, literal);
  } catch (err) {
    if (err instanceof NotAGitRepo) {
      return legacyWalkGrep(cwd, pattern, glob, cap, literal);
    }
    if (err instanceof GitGrepTimeout) {
      return `Note: git grep timed out after ${GIT_GREP_TIMEOUT_MS / 1000}s; ` +
        `narrow the glob or pattern and retry\n`;
    }
    const detail = err instanceof Error ? err.message : String(err);
    return `Note: git grep failed (${detail}); results below may be incomplete\n`;
  }
}

/** Raised when cwd is not inside a git work tree — caller falls back. */
class NotAGitRepo extends Error {}
/** Raised when git grep exceeded its deadline. */
class GitGrepTimeout extends Error {}

async function gitGrep(
  cwd: string,
  pattern: string,
  glob: string | undefined,
  cap: number,
  literal?: boolean,
): Promise<string> {
  const args = [
    "-c", "core.quotepath=false",
    "grep",
    "--no-color",
    "-n",
    // Paths come back relative to cwd (git's default; --full-name would make
    // them repo-root-relative). No --relative here: it only exists in
    // git >= 2.44 and older runners reject the whole invocation.
    "--untracked",
    literal ? "-F" : "-P",
    "-e", pattern,
  ];
  if (glob) args.push("--", `:(glob)${glob}`);

  const stdout = await runGitGrep(cwd, args);
  // Count every matching line (files beyond the render budget included) so
  // the truncation note reports the true scale, then render at most `cap`.
  const lines = stdout.split("\n").filter((line) => line !== "");
  const rendered: string[] = [];
  let truncated = false;
  for (const line of lines) {
    if (rendered.length >= cap) {
      truncated = true;
      break;
    }
    rendered.push(line.slice(0, LINE_RENDER_CAP));
  }
  if (!truncated) return rendered.join("\n");
  const files = new Set(
    lines.map((line) => {
      const idx = line.indexOf(":");
      return idx >= 0 ? line.slice(0, idx) : line;
    }),
  );
  return (
    `Note: showing first ${cap} of ${lines.length} matches across ${files.size} ` +
    `matching files; narrow the glob or pattern to see the rest\n` +
    rendered.join("\n")
  );
}

async function runGitGrep(cwd: string, args: string[]): Promise<string> {
  let stdout: string;
  let stderr: string;
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      timeout: GIT_GREP_TIMEOUT_MS,
      maxBuffer: GIT_GREP_MAX_BUFFER,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { code?: number | string; stdout?: string; stderr?: string; killed?: boolean };
    if (e.killed) throw new GitGrepTimeout("deadline exceeded");
    stdout = e.stdout ?? "";
    stderr = e.stderr ?? "";
    // git grep exits 1 on "no matches" — distinct from real failures.
    if (typeof e.code === "number" && e.code === 1 && stdout === "") return "";
    if (
      typeof e.code === "number" &&
      e.code === 128 &&
      /not a git repository/i.test(stderr)
    ) {
      throw new NotAGitRepo(stderr.trim());
    }
    throw new Error(trimFirstLine(stderr) || `git exited with ${String(e.code)}`);
  }
  if (stdout === "" && stderr !== "") {
    // Zero matches with a warning (e.g. untracked dir unreadable): still no
    // matches; the warning is not worth derailing the caller for.
    return "";
  }
  return stdout;
}

function trimFirstLine(stderr: string): string {
  const first = stderr.split("\n", 1)[0] ?? "";
  return first.trim();
}

/**
 * Legacy fallback for non-git directories: plain tree walk with the
 * hardcoded IGNORE list. Kept verbatim from the pre-#76 implementation —
 * without git there is no tracked/gitignore signal to delegate to.
 */
const IGNORE: Record<string, true> = {
  node_modules: true,
  ".git": true,
  dist: true,
  build: true,
  ".next": true,
  ".cache": true,
  coverage: true,
  ".turbo": true,
  vendor: true,
};

async function legacyWalkGrep(
  cwd: string,
  pattern: string,
  glob: string | undefined,
  cap: number,
  literal?: boolean,
): Promise<string> {
  const out: string[] = [];
  const matcher = glob ? compileGlob(glob) : null;
  let match: (line: string) => boolean;
  if (literal) {
    match = (line) => line.includes(pattern);
  } else {
    const re = safeRegex(pattern);
    if (!re) return ""; // invalid regex → no matches
    match = (line) => re.test(line);
  }

  async function visit(dir: string): Promise<void> {
    if (out.length >= cap) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (out.length >= cap) return;
      if (ent.isDirectory()) {
        if (ent.name in IGNORE) continue;
        await visit(path.join(dir, ent.name));
        continue;
      }
      if (!ent.isFile()) continue;
      // Normalize to forward slashes: globs use `/` as the separator on every
      // platform, but `path.relative` yields `\` on Windows.
      const rel = path.relative(cwd, path.join(dir, ent.name)).split(path.sep).join("/");
      if (matcher && !matcher(rel)) continue;
      try {
        const text = await readFile(path.join(dir, ent.name), "utf8");
        const lines = text.split("\n");
        for (let i = 0; i < lines.length && out.length < cap; i++) {
          if (match(lines[i])) {
            out.push(`${rel}:${i + 1}:${lines[i].slice(0, 200)}`);
          }
        }
      } catch {
        // binary or unreadable: skip.
      }
    }
  }

  await visit(cwd);
  return out.slice(0, cap).join("\n");
}

/** Minimal glob: '*' = any-non-separator, '**' = any including separators. */
function compileGlob(glob: string): (p: string) => boolean {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  try {
    const full = new RegExp(`^${re}$`);
    return (p) => full.test(p);
  } catch {
    return () => false;
  }
}

/** Compile a regex pattern, returning null if invalid. */
function safeRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}
