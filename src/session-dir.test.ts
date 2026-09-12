import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveSessionDirName } from "./session-dir.js";

describe("resolveSessionDirName", () => {
  it("falls back to the PR number when no session key is given", () => {
    assert.equal(resolveSessionDirName(undefined, 123), "123");
    assert.equal(resolveSessionDirName(undefined, 0), "0");
  });

  it("passes through ordinary keys unchanged", () => {
    assert.equal(resolveSessionDirName("aacr__instance-42", 0), "aacr__instance-42");
    assert.equal(resolveSessionDirName("bench-7.x_y-z", 0), "bench-7.x_y-z");
  });

  it("collapses unsafe characters to underscores", () => {
    assert.equal(resolveSessionDirName("a/b", 0), "a_b");
    assert.equal(resolveSessionDirName("owner name/PR#3", 0), "owner_name_PR_3");
    assert.equal(resolveSessionDirName("/abs/path", 0), "_abs_path");
    assert.equal(resolveSessionDirName("a//b", 0), "a_b");
    assert.equal(resolveSessionDirName("///", 0), "_");
  });

  it("rejects traversal-shaped results via a deterministic hash fallback", () => {
    // Sanitized form would be "." / ".." / ".."-prefixed — unusable as a
    // path segment. The fallback must never be one of those shapes, must be
    // deterministic (same key → same dir, resume survives), and must differ
    // per key.
    const dotdot = resolveSessionDirName("..", 0);
    const dotdotPath = resolveSessionDirName("../../x", 0);
    assert.match(dotdot, /^key-[0-9a-f]{8}$/);
    assert.match(dotdotPath, /^key-[0-9a-f]{8}$/);
    assert.equal(dotdot, resolveSessionDirName("..", 0));
    assert.notEqual(dotdot, dotdotPath);
  });

  it("hashes the empty key instead of producing an empty name", () => {
    assert.match(resolveSessionDirName("", 0), /^key-[0-9a-f]{8}$/);
  });

  it("a dotted-but-usable key stays readable (hash only for unsafe shapes)", () => {
    assert.equal(resolveSessionDirName("v1.2.3", 0), "v1.2.3");
    assert.equal(resolveSessionDirName("a..b", 0), "a..b");
    assert.equal(resolveSessionDirName("...", 0).startsWith("key-"), true);
  });
});
