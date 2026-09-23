import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { walkGrep } from "./walk-grep.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "walk-grep-test-"));
  await mkdir(path.join(dir, "src"));
  await writeFile(
    path.join(dir, "src", "auth.ts"),
    [
      "export function validateToken(token: string): boolean {",
      "  if (!token) return false;",
      "  const parts = token.split('.');",
      "  return parts.length === 3;",
      "}",
      "",
      "export function parseJWT(token: string) {",
      "  try {",
      "    return JSON.parse(atob(token.split('.')[1]));",
      "  } catch (e) {",
      "    return null;",
      "  }",
      "}",
    ].join("\n"),
  );
  await writeFile(
    path.join(dir, "src", "user.ts"),
    [
      'import { validateToken } from "./auth";',
      "",
      "export function getUser(token: string) {",
      "  if (!validateToken(token)) throw new Error('invalid');",
      "  return { id: '1' };",
      "}",
    ].join("\n"),
  );
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("walkGrep", () => {
  // --- regex mode (default) ---

  it("matches regex pattern", async () => {
    const out = await walkGrep(dir, "catch\\s*\\(", undefined, 50);
    assert.ok(out.includes("auth.ts"), "should find auth.ts");
    assert.ok(out.includes("catch (e)"), "should match catch (e)");
  });

  it("matches character classes", async () => {
    const out = await walkGrep(dir, "parts\\.length === \\d", undefined, 50);
    assert.ok(out.includes("parts.length === 3"), "should match with \\d");
  });

  it("matches alternation", async () => {
    const out = await walkGrep(dir, "validateToken|parseJWT", undefined, 50);
    assert.ok(out.includes("validateToken"), "should match validateToken");
    assert.ok(out.includes("parseJWT"), "should match parseJWT");
  });

  it("returns empty for invalid regex", async () => {
    const out = await walkGrep(dir, "[invalid(", undefined, 50);
    assert.equal(out, "");
  });

  it("respects cap", async () => {
    const out = await walkGrep(dir, "\\w+", undefined, 2);
    const lines = out.split("\n").filter(Boolean);
    assert.ok(lines.length <= 2, `expected <= 2 lines, got ${lines.length}`);
  });

  // --- literal mode ---

  it("matches literal strings when literal=true", async () => {
    const out = await walkGrep(dir, "token.split('.')", undefined, 50, true);
    assert.ok(out.includes("token.split('.')"), "should find literal match");
  });

  it("treats regex metacharacters as literal when literal=true", async () => {
    const out = await walkGrep(dir, "parts.length === 3", undefined, 50, true);
    assert.ok(out.includes("parts.length === 3"), "should find literal match");
  });

  // --- glob filtering ---

  it("filters by glob", async () => {
    const out = await walkGrep(dir, "validateToken", "**/*.ts", 50);
    assert.ok(out.includes("auth.ts"), "should find auth.ts");
    assert.ok(out.includes("user.ts"), "should find user.ts");
  });

  it("excludes non-matching globs", async () => {
    const out = await walkGrep(dir, "validateToken", "**/*.md", 50);
    assert.equal(out, "");
  });

  // --- edge cases ---

  it("returns empty for empty pattern", async () => {
    const out = await walkGrep(dir, "", undefined, 50);
    assert.equal(out, "");
  });

  it("skips node_modules", async () => {
    await mkdir(path.join(dir, "node_modules"));
    await writeFile(path.join(dir, "node_modules", "junk.ts"), "validateToken");
    const out = await walkGrep(dir, "validateToken", undefined, 50);
    assert.ok(!out.includes("node_modules"), "should skip node_modules");
  });
});

// --- git mode: the primary backend (issue #76) ---

describe("walkGrep (git repo)", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), "walk-grep-git-"));
    const run = (await import("node:child_process")).execFileSync;
    const git = (...args: string[]) =>
      run("git", args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    await writeFile(path.join(repo, ".gitignore"), "ignored/\n");
    // A committed build artifact: the exact #76 shape — tracked dist/ that
    // the old hardcoded IGNORE list refused to search.
    const distDir = path.join(repo, "dist", "nested");
    await mkdir(distDir, { recursive: true });
    await writeFile(path.join(distDir, "bundle.js"), "export const unquoteGitPath = 1;\n");
    // A committed non-ASCII filename: paths must come back literally (#74).
    const cnDir = path.join(repo, "content", "post", "中文路径");
    await mkdir(cnDir, { recursive: true });
    await writeFile(path.join(cnDir, "index.md"), "needle octal-path\n");
    // Untracked-but-not-ignored file, and a gitignored file.
    await writeFile(path.join(repo, "untracked.ts"), "needle fresh\n");
    const ignoredDir = path.join(repo, "ignored");
    await mkdir(ignoredDir);
    await writeFile(path.join(ignoredDir, "secret.ts"), "needle skipped\n");
    git("add", "dist", "content", ".gitignore");
    git("commit", "-q", "-m", "init");
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("searches committed build artifacts (the #76 case)", async () => {
    const out = await walkGrep(repo, "unquoteGitPath", undefined, 50);
    assert.match(out, /dist\/nested\/bundle\.js:1:/);
  });

  it("reports non-ASCII paths literally, not octal-escaped", async () => {
    const out = await walkGrep(repo, "octal-path", undefined, 50);
    assert.ok(out.includes("中文路径"), `expected literal CJK path in: ${out}`);
    assert.ok(!out.includes("\\344"), "must not octal-escape the path");
  });

  it("searches untracked files but honors .gitignore", async () => {
    const out = await walkGrep(repo, "needle", undefined, 50);
    assert.match(out, /untracked\.ts:1:/);
    assert.ok(!out.includes("ignored/"), "gitignored dir must not be searched");
  });

  it("filters by glob via git pathspec", async () => {
    const out = await walkGrep(repo, "needle", "**/*.md", 50);
    assert.match(out, /index\.md:1:/);
    assert.ok(!out.includes("untracked.ts"), "glob must exclude non-matching files");
  });

  it("returns empty string on no matches", async () => {
    const out = await walkGrep(repo, "definitely-not-present", undefined, 50);
    assert.equal(out, "");
  });

  it("caps rendering and reports true totals in a Note line", async () => {
    const out = await walkGrep(repo, "needle|unquoteGitPath", undefined, 1);
    const lines = out.split("\n");
    assert.match(lines[0]!, /^Note: showing first 1 of \d+ matches/);
    assert.equal(lines.filter((l) => l !== "" && !l.startsWith("Note:")).length, 1);
  });
});
