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

  it("matches regex patterns", async () => {
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
