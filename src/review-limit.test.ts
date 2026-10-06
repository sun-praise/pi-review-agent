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
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");

const tmpRoots: string[] = [];

after(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
});

/** Spawn env with platform vars scrubbed: CI exports GITHUB_REPOSITORY (and
 * a PR ref) into test steps, which would route the #88 notice path into a
 * real API call from inside these tests. The gate itself needs none of
 * them. */
function scrubbedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    "GITHUB_REPOSITORY",
    "GITHUB_TOKEN",
    "GITHUB_REF",
    "GITHUB_API_URL",
    "PI_REVIEW_HEAD_SHA",
    "GITEA_URL",
    "GITEA_TOKEN",
  ]) {
    delete env[key];
  }
  return env;
}

function spawnCli(sessionsRoot: string, extraArgs: string[]): { stdout: string; stderr: string } {
  const res = spawnSync(
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
    { cwd: REPO_ROOT, encoding: "utf8", env: scrubbedEnv() },
  );
  assert.equal(res.status, 0, `CLI exited ${res.status}\nstderr: ${res.stderr}`);
  return { stdout: res.stdout, stderr: res.stderr };
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
    const { stdout, stderr } = spawnCli(root, ["--format", "json"]);
    const parsed: unknown = JSON.parse(stdout);
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
    // Headless mode never posts PR comments — not even the skip notice.
    assert.ok(!stderr.includes("skip notice:"));
    // A skip is not a review — the counter must not move.
    assert.equal(await readFile(join(root, "9", "review-count.json"), "utf8"), '{"count":3}\n');
  });

  it("text mode: a skipped run warns visibly (::warning:: annotation), attempts the #88 notice, exits 0, counter untouched", async () => {
    const root = await limitedRoot();
    const { stdout, stderr } = spawnCli(root, []);
    assert.match(stdout, /::warning::max-reviews-per-pr: 3 reviews already recorded/);
    // The notice path runs in the real CLI even when it cannot post (no
    // platform env here) — its diagnostic proves main() routes skips
    // through postSkipNoticeFromEnv instead of exiting silently.
    assert.match(stderr, /skip notice:/);
    assert.equal(await readFile(join(root, "9", "review-count.json"), "utf8"), '{"count":3}\n');
  });
});
