/**
 * End-to-end regression tests for the max-reviews-per-pr gate routing
 * (#84, demanded by this PR's own dogfood: the buildSkippedJsonResult unit
 * tests pin the payload SHAPE, but nothing pinned that main() actually
 * routes a skipped run through it — deleting or moving the
 * `opts.format === "json"` branch would put plain text on stdout again and
 * every payload test would stay green).
 *
 * Spawns the real CLI entry (src/index.ts under tsx, same as `npm test`
 * runs). The gate sits before diff loading, workspace checks, platform
 * detection, and any LLM work, so a limit-reaching run needs ONLY a
 * counter fixture — no diff file, no platform env, no API key. That also
 * pins the gate's precedence: if it ever moves behind the "no diff
 * source" failure, these spawns exit 1 and the tests go red.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");

const tmpRoots: string[] = [];

after(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
});

function spawnCli(sessionsRoot: string, extraArgs: string[]): string {
  return execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      join(REPO_ROOT, "src", "index.ts"),
      "--pr",
      "9",
      "--persona",
      "quality",
      "--sessions-root",
      sessionsRoot,
      "--max-reviews-per-pr",
      "3",
      ...extraArgs,
    ],
    // cwd must be the repo root so tsx and the project's deps resolve.
    { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

/** Fixture sessions-root with the counter already at the limit. */
async function limitedRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-review-limit-"));
  tmpRoots.push(root);
  await mkdir(join(root, "9"), { recursive: true });
  await writeFile(join(root, "9", "review-count.json"), '{"count":3}\n');
  return root;
}

describe("max-reviews-per-pr gate routing (spawned CLI, #84)", () => {
  it("json mode: a skipped run prints ONE parseable JSON document with skipped.reason, exits 0, and never bumps the counter", async () => {
    const root = await limitedRoot();
    const out = spawnCli(root, ["--format", "json"]);
    const parsed: unknown = JSON.parse(out);
    assert.ok(typeof parsed === "object" && parsed !== null && "skipped" in parsed);
    const record = parsed as Record<string, unknown>;
    const skipped = record.skipped as {
      reason: string;
      completed: number;
      limit: number;
    };
    assert.equal(skipped.reason, "review-limit");
    assert.equal(skipped.completed, 3);
    assert.equal(skipped.limit, 3);
    // Identity came from --pr (no --session-key) → sessionKey stays
    // undefined, same contract as the dispatch paths.
    assert.equal(record.sessionKey, undefined);
    // A skip is not a review — the counter must not move.
    assert.equal(await readFile(join(root, "9", "review-count.json"), "utf8"), '{"count":3}\n');
  });

  it("text mode: a skipped run warns visibly (::warning:: annotation), exits 0, counter untouched", async () => {
    const root = await limitedRoot();
    const out = spawnCli(root, []);
    assert.match(out, /::warning::max-reviews-per-pr: 3 reviews already recorded/);
    assert.equal(await readFile(join(root, "9", "review-count.json"), "utf8"), '{"count":3}\n');
  });
});
