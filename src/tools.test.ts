import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile as write } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createReadFileTool } from "./tools.js";

/**
 * Security tests for createReadFileTool: it MUST confine reads to cwd so a
 * prompt-injected reviewer/verifier can't exfiltrate files outside the repo
 * (secrets, ~/.ssh, /etc/passwd) by passing an absolute or traversing path.
 *
 * Each case drives the tool's `execute` directly (no agent runtime needed):
 * the first execute arg is a synthetic request id; the second is the params.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "tools-test-"));
  await mkdir(path.join(dir, "src"), { recursive: true });
  await write(path.join(dir, "src", "foo.ts"), "line1\nline2\nline3");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Run the read tool and pull the text out of its content[0]. */
async function read(cwd: string, filePath: string): Promise<string> {
  const tool = createReadFileTool(cwd);
  const res = await tool.execute("id", { path: filePath });
  return (res.content[0] as { type: "text"; text: string }).text;
}

describe("createReadFileTool — confinement", () => {
  it("reads a normal relative path inside the repo", async () => {
    const text = await read(dir, "src/foo.ts");
    assert.equal(text, "1: line1\n2: line2\n3: line3");
  });

  it("refuses an absolute path outside the repo", async () => {
    const outside = path.join(tmpdir(), "tools-outside-target");
    await mkdir(outside, { recursive: true });
    await write(path.join(outside, "secret.txt"), "TOPSECRET", "utf8");
    try {
      const text = await read(dir, path.join(outside, "secret.txt"));
      assert.match(text, /refused/i);
      assert.ok(!text.includes("TOPSECRET"), "must not leak outside-repo contents");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses a relative path that traverses above cwd (..)", async () => {
    // Plant a secret one level above the repo root.
    const secretPath = path.join(path.dirname(dir), "parent-secret.txt");
    await write(secretPath, "PARENTSECRET", "utf8");
    try {
      const text = await read(dir, "../parent-secret.txt");
      assert.match(text, /refused/i);
      assert.ok(!text.includes("PARENTSECRET"), "must not leak parent-dir contents");
    } finally {
      await rm(secretPath, { force: true });
    }
  });

  it("refuses a deep traversal (../../etc/...)", async () => {
    const text = await read(dir, "../../../../../../../../etc/passwd");
    assert.match(text, /refused/i);
    assert.ok(!text.includes("root:"), "must not read /etc/passwd");
  });

  it("refuses a sibling directory that shares a name prefix with cwd (the startsWith trap)", async () => {
    // A buggy `abs.startsWith(root)` check would accept a path under a sibling
    // whose name begins with cwd's name (e.g. "tools-test-XYZ-evil" vs
    // "tools-test-XYZ"). path.relative correctly flags it as "../sibling".
    // Reach the sibling from inside dir via "..", so the escape is explicit.
    const sibling = `${dir}-evil`;
    await mkdir(sibling, { recursive: true });
    await write(path.join(sibling, "stolen.txt"), "SIBLINGSECRET", "utf8");
    try {
      const text = await read(dir, `../${path.basename(dir)}-evil/stolen.txt`);
      assert.match(text, /refused/i);
      assert.ok(!text.includes("SIBLINGSECRET"), "must not leak sibling-dir contents");
    } finally {
      await rm(sibling, { recursive: true, force: true });
    }
  });

  it("does not refuse cwd itself — confinement allows it (the FS then rejects the directory read)", async () => {
    // "." resolves to cwd; resolveInside returns it (not null). readFile then
    // throws EISDIR because it's a directory — that's a normal read error,
    // NOT a confinement refusal. We assert the refusal path was NOT taken.
    await assert.rejects(
      () => read(dir, "."),
      (err: NodeJS.ErrnoException) => err.code === "EISDIR",
      "cwd itself should pass confinement and let the FS error surface as EISDIR",
    );
  });

  it("still reads nested files with a normal relative path", async () => {
    await mkdir(path.join(dir, "a", "b"), { recursive: true });
    await write(path.join(dir, "a", "b", "deep.ts"), "deep", "utf8");
    const text = await read(dir, "a/b/deep.ts");
    assert.equal(text, "1: deep");
  });
});
