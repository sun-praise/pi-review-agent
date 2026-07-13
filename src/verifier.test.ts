import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { verifyInlineComments, type LLMVerifyFn, type VerifyOptions } from "./verifier.js";
import type { InlineComment } from "./inline-comments.js";
import type { ChangedLines } from "./changed-lines.js";

/** Build changedLines map with a single file's left/right sets. */
function cl(file: string, left: number[], right: number[]): Map<string, ChangedLines> {
  return new Map([[file, { left: new Set(left), right: new Set(right) }]]);
}

function comment(file: string, line: number, side: "LEFT" | "RIGHT", body = "x"): InlineComment {
  return { file, line, side, severity: "blocking", body };
}

describe("verifyInlineComments — rule layer", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pi-verify-"));
    await mkdir(path.join(dir, "src"), { recursive: true });
    // src/foo.ts with at least 5 lines so line numbers resolve on disk.
    await writeFile(path.join(dir, "src/foo.ts"), "a\nb\nc\nd\ne\n");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("verifies a finding whose line is in the changed set and file exists", async () => {
    const opts: VerifyOptions = { cwd: dir, changedLines: cl("src/foo.ts", [], [3]), skipLlm: true };
    const r = await verifyInlineComments([comment("src/foo.ts", 3, "RIGHT")], opts);
    assert.equal(r.summary.verified, 1);
    assert.equal(r.summary.demoted, 0);
    assert.equal(r.comments[0].status, "verified");
  });

  it("demotes a finding on a file absent from the diff", async () => {
    const opts: VerifyOptions = { cwd: dir, changedLines: cl("src/foo.ts", [], [3]), skipLlm: true };
    const r = await verifyInlineComments([comment("src/other.ts", 3, "RIGHT")], opts);
    assert.equal(r.summary.demoted, 1);
    assert.equal(r.comments[0].status, "demoted");
    assert.match(r.comments[0].demoteReason ?? "", /not in diff/);
  });

  it("demotes a finding whose line is not changed on that side", async () => {
    const opts: VerifyOptions = { cwd: dir, changedLines: cl("src/foo.ts", [2], [3]), skipLlm: true };
    // line 99 not in right set; line 2 is a left-side change, not right.
    const r = await verifyInlineComments(
      [comment("src/foo.ts", 99, "RIGHT"), comment("src/foo.ts", 2, "RIGHT")],
      opts,
    );
    assert.equal(r.summary.demoted, 2);
    assert.match(r.comments[0].demoteReason ?? "", /line 99/);
  });

  it("checks LEFT side against the left set", async () => {
    const opts: VerifyOptions = { cwd: dir, changedLines: cl("src/foo.ts", [2], [3]), skipLlm: true };
    const r = await verifyInlineComments([comment("src/foo.ts", 2, "LEFT")], opts);
    assert.equal(r.summary.verified, 1);
  });

  it("demotes when the file does not exist on disk", async () => {
    const opts: VerifyOptions = { cwd: dir, changedLines: cl("src/ghost.ts", [], [3]), skipLlm: true };
    const r = await verifyInlineComments([comment("src/ghost.ts", 3, "RIGHT")], opts);
    assert.equal(r.summary.demoted, 1);
    assert.match(r.comments[0].demoteReason ?? "", /not found on disk/);
  });

  it("preserves input order in the output", async () => {
    const opts: VerifyOptions = { cwd: dir, changedLines: cl("src/foo.ts", [], [3, 4]), skipLlm: true };
    const r = await verifyInlineComments(
      [comment("src/foo.ts", 4, "RIGHT"), comment("src/foo.ts", 3, "RIGHT"), comment("src/x", 3, "RIGHT")],
      opts,
    );
    assert.deepEqual(r.comments.map((c) => c.line), [4, 3, 3]);
  });
});

describe("verifyInlineComments — LLM layer", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pi-verify-"));
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src/foo.ts"), "a\nb\nc\nd\ne\n");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("demotes a finding the LLM judges as contradicting the code", async () => {
    const llm: LLMVerifyFn = async () => ({ verdict: "demote", reason: "no such call" });
    const opts: VerifyOptions = { cwd: dir, changedLines: cl("src/foo.ts", [], [3]), llmVerify: llm };
    const r = await verifyInlineComments([comment("src/foo.ts", 3, "RIGHT")], opts);
    assert.equal(r.summary.demoted, 1);
    assert.equal(r.comments[0].demoteReason, "no such call");
  });

  it("keeps a finding verified when the LLM upholds it", async () => {
    const llm: LLMVerifyFn = async () => ({ verdict: "uphold", reason: "matches" });
    const opts: VerifyOptions = { cwd: dir, changedLines: cl("src/foo.ts", [], [3]), llmVerify: llm };
    const r = await verifyInlineComments([comment("src/foo.ts", 3, "RIGHT")], opts);
    assert.equal(r.summary.verified, 1);
  });

  it("does NOT demote when the LLM returns null (uncertain)", async () => {
    const llm: LLMVerifyFn = async () => null;
    const opts: VerifyOptions = { cwd: dir, changedLines: cl("src/foo.ts", [], [3]), llmVerify: llm };
    const r = await verifyInlineComments([comment("src/foo.ts", 3, "RIGHT")], opts);
    assert.equal(r.summary.verified, 1, "null verdict must stay verified (fail-open)");
  });

  it("does NOT demote when the LLM throws", async () => {
    const llm: LLMVerifyFn = async () => {
      throw new Error("network");
    };
    const opts: VerifyOptions = { cwd: dir, changedLines: cl("src/foo.ts", [], [3]), llmVerify: llm };
    const r = await verifyInlineComments([comment("src/foo.ts", 3, "RIGHT")], opts);
    assert.equal(r.summary.verified, 1, "LLM exception must stay verified (fail-open)");
  });

  it("only invokes the LLM for findings that passed the rule layer", async () => {
    const seen: string[] = [];
    const llm: LLMVerifyFn = async (c) => {
      seen.push(`${c.file}:${c.line}`);
      return { verdict: "uphold", reason: "ok" };
    };
    const opts: VerifyOptions = {
      cwd: dir,
      changedLines: cl("src/foo.ts", [], [3]),
      llmVerify: llm,
    };
    // 3 passes rule layer; 99 fails it (line not changed).
    await verifyInlineComments(
      [comment("src/foo.ts", 3, "RIGHT"), comment("src/foo.ts", 99, "RIGHT")],
      opts,
    );
    assert.deepEqual(seen, ["src/foo.ts:3"], "rule-layer-demoted findings skip the LLM");
  });

  it("skipLlm:true runs rule layer only, ignoring any llmVerify", async () => {
    let called = 0;
    const llm: LLMVerifyFn = async () => {
      called++;
      return { verdict: "demote", reason: "x" };
    };
    const opts: VerifyOptions = { cwd: dir, changedLines: cl("src/foo.ts", [], [3]), llmVerify: llm, skipLlm: true };
    const r = await verifyInlineComments([comment("src/foo.ts", 3, "RIGHT")], opts);
    assert.equal(called, 0);
    assert.equal(r.summary.verified, 1);
  });

  it("bounds LLM concurrency to the configured limit", async () => {
    // Track how many LLM calls are in flight at once; the high-water mark
    // must not exceed opts.concurrency. 8 findings, limit 3 → peak ≤ 3.
    let inFlight = 0;
    let peak = 0;
    const llm: LLMVerifyFn = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return { verdict: "uphold", reason: "ok" };
    };
    const findings = Array.from({ length: 8 }, (_, i) => comment("src/foo.ts", i + 1, "RIGHT"));
    const opts: VerifyOptions = {
      cwd: dir,
      changedLines: cl("src/foo.ts", [], [1, 2, 3, 4, 5, 6, 7, 8]),
      llmVerify: llm,
      concurrency: 3,
    };
    await verifyInlineComments(findings, opts);
    assert.ok(peak <= 3, `peak concurrency ${peak} exceeded limit 3`);
    assert.ok(peak >= 2, `peak concurrency ${peak} suggests serial execution`);
  });
});
