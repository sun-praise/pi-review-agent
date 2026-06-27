/**
 * Review-agent entry. Two modes:
 *
 * Single-persona CLI:
 *   tsx src/index.ts --pr 123 --diff-file ./diff.txt --persona quality
 *
 * Team mode (multi-persona + coordinator + PR comment):
 *   tsx src/index.ts --pr 123 --diff-file ./diff.txt --team "quality:1,security:1"
 *   # in a GitHub Action the PR comment is posted automatically when
 *   # GITHUB_TOKEN + GITHUB_REF are set.
 *
 * Env-driven (GitHub Action):
 *   PI_REVIEW_PR=123
 *   PI_REVIEW_DIFF_FILE=/tmp/diff.txt   (or PI_REVIEW_DIFF=<inline text>)
 *   PI_REVIEW_TEAM=quality:1,security:1  (omit → all built-ins)
 *   PI_REVIEW_SKIP_COORDINATOR=1         (optional; default runs coordinator)
 *   GITHUB_TOKEN=...                     (sets PR comment posting in motion)
 *   GITHUB_STEP_SUMMARY=...              (cost table appended here)
 *   GITHUB_OUTPUT=...                    (cacheRead, costTotal, verdict, ...)
 */
import { readFileSync, appendFileSync } from "node:fs";
import { createLiteLLMDeepSeekProvider } from "./provider.js";
import { runReview, type ReviewResult } from "./review.js";
import { runTeamReview, renderTeamComment, type TeamReviewResult } from "./orchestrate.js";
import { postPrComment, prCommentContextFromEnv } from "./pr-comment.js";

interface CliOptions {
  pr: number;
  diffFile: string | undefined;
  diffInline: string | undefined;
  persona: string | undefined;
  team: string | undefined;
  skipCoordinator: boolean;
  baseURL: string;
  sessionsRoot: string;
  modelId: string | undefined;
  cwd: string;
}

function parseArgs(argv: string[]): CliOptions {
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i += 2) {
    const k = argv[i]?.replace(/^--/, "");
    args[k ?? ""] = argv[i + 1] ?? "";
  }
  const pr = Number(args.pr || process.env.PI_REVIEW_PR || 0);
  if (!Number.isFinite(pr) || pr <= 0) {
    throw new Error(`--pr <number> (or PI_REVIEW_PR) required`);
  }
  const persona = args.persona || process.env.PI_REVIEW_PERSONA;
  const team = args.team || process.env.PI_REVIEW_TEAM;
  // GitHub Actions always injects env vars as strings, so the literal "false"
  // from action.yml inputs.skip-coordinator must NOT be truthy. Only "1"/"true"
  // (case-insensitive) enable skipping.
  const skipEnv = process.env.PI_REVIEW_SKIP_COORDINATOR;
  if (!persona && !team) {
    throw new Error("--persona <name> or --team <spec> required");
  }
  return {
    pr,
    diffFile: args["diff-file"] || process.env.PI_REVIEW_DIFF_FILE,
    diffInline: process.env.PI_REVIEW_DIFF,
    persona,
    team,
    skipCoordinator: skipEnv === "1" || skipEnv?.toLowerCase() === "true" || args["skip-coordinator"] === "true",
    baseURL: args["base-url"] || process.env.LITELLM_BASE_URL || "https://llm.sun-praise.com",
    sessionsRoot: args["sessions-root"] || process.env.PI_REVIEW_SESSIONS_ROOT || "./sessions",
    modelId: args.model || process.env.PI_REVIEW_MODEL,
    cwd: args.cwd || process.cwd(),
  };
}

function loadDiff(opts: CliOptions): string {
  if (opts.diffInline) return opts.diffInline;
  if (opts.diffFile) return readFileSync(opts.diffFile, "utf8");
  throw new Error("no diff source: set --diff-file, PI_REVIEW_DIFF_FILE, or PI_REVIEW_DIFF");
}

function appendStepSummary(markdown: string): void {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  appendFileSync(path, markdown);
}

function appendOutputs(lines: string[]): void {
  const path = process.env.GITHUB_OUTPUT;
  if (!path) return;
  appendFileSync(path, lines.join("\n") + "\n");
}

function writeSingleSummary(result: ReviewResult, persona: string): void {
  const md =
    `### pi-review-agent — ${persona} (resumed=${result.resumed})\n\n` +
    `| metric | value |\n|---|---|\n` +
    `| input tokens | ${result.usage.input} |\n` +
    `| output tokens | ${result.usage.output} |\n` +
    `| **cacheRead** | **${result.usage.cacheRead}** (hit → discounted) |\n` +
    `| cacheWrite | ${result.usage.cacheWrite} |\n` +
    `| cost (USD) | $${result.usage.costTotal.toFixed(6)} |\n\n` +
    `<details><summary>review</summary>\n\n${result.content}\n\n</details>\n`;
  appendStepSummary(md);
}

function writeTeamSummary(result: TeamReviewResult): void {
  const lines: string[] = [];
  lines.push(`### pi-review-agent — team review (${result.personas.length} reviewers)`);
  lines.push("");
  lines.push("| persona | resumed | input | output | cacheRead | cost (USD) |");
  lines.push("|---|---|---|---|---|---|");
  for (const r of result.personas) {
    lines.push(
      `| ${r.persona} | ${r.result.resumed} | ${r.result.usage.input} | ${r.result.usage.output} | ${r.result.usage.cacheRead} | $${r.result.usage.costTotal.toFixed(6)} |`,
    );
  }
  if (result.coordinator) {
    lines.push(
      `| coordinator | ${result.coordinator.resumed} | ${result.coordinator.usage.input} | ${result.coordinator.usage.output} | ${result.coordinator.usage.cacheRead} | $${result.coordinator.usage.costTotal.toFixed(6)} |`,
    );
  }
  lines.push("");
  lines.push(`**Verdict: ${result.verdict}**`);
  lines.push(`**Total cost: $${result.totalCost.toFixed(6)} · cacheRead ${result.totalCacheRead}**`);
  lines.push("");
  appendStepSummary(lines.join("\n"));
  appendOutputs([
    `verdict=${result.verdict}`,
    `totalCost=${result.totalCost.toFixed(6)}`,
    `totalCacheRead=${result.totalCacheRead}`,
  ]);
}

async function runSingle(opts: CliOptions): Promise<void> {
  const provider = createLiteLLMDeepSeekProvider({ baseURL: opts.baseURL, modelId: opts.modelId });
  const persona = opts.persona as string;
  const diff = loadDiff(opts);
  const result = await runReview({
    provider,
    pr: opts.pr,
    persona,
    diff,
    sessionsRoot: opts.sessionsRoot,
    cwd: opts.cwd,
  });
  process.stdout.write(`\n=== review (${persona}, resumed=${result.resumed}) ===\n${result.content}\n`);
  process.stdout.write(
    `cacheRead: ${result.usage.cacheRead}  cost: $${result.usage.costTotal.toFixed(6)}\n`,
  );
  writeSingleSummary(result, persona);
  appendOutputs([
    `cacheRead=${result.usage.cacheRead}`,
    `costTotal=${result.usage.costTotal.toFixed(6)}`,
    `resumed=${result.resumed}`,
    `sessionId=${result.sessionId}`,
  ]);
}

async function runTeam(opts: CliOptions): Promise<void> {
  const diff = loadDiff(opts);
  const provider = createLiteLLMDeepSeekProvider({ baseURL: opts.baseURL, modelId: opts.modelId });
  const result = await runTeamReview({
    provider,
    pr: opts.pr,
    diff,
    cwd: opts.cwd,
    sessionsRoot: opts.sessionsRoot,
    team: opts.team,
    skipCoordinator: opts.skipCoordinator,
  });
  process.stdout.write(`\n=== team review (${result.personas.length} personas) ===\n`);
  process.stdout.write(`verdict: ${result.verdict}\n`);
  process.stdout.write(
    `total cost: $${result.totalCost.toFixed(6)} · cacheRead ${result.totalCacheRead}\n`,
  );
  if (result.coordinator) {
    process.stdout.write(`\n--- coordinator ---\n${result.coordinator.content}\n`);
  }
  for (const r of result.personas) {
    process.stdout.write(`\n--- ${r.persona} ---\n${r.result.content}\n`);
  }
  writeTeamSummary(result);

  const ctx = prCommentContextFromEnv(process.env);
  if (ctx) {
    const body = renderTeamComment(result);
    const outcome = await postPrComment(ctx, body);
    process.stdout.write(`\nPR comment: ${outcome}\n`);
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);
  if (opts.team) {
    await runTeam(opts);
  } else {
    await runSingle(opts);
  }
}

main().catch((err) => {
  console.error("pi-review-agent failed:", err);
  process.exit(1);
});
