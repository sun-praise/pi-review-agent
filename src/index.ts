/**
 * Review-agent entry. Two modes:
 *
 * CLI:
 *   tsx src/index.ts --pr 123 --diff-file ./diff.txt --persona quality
 *
 * GitHub Action (env-driven):
 *   PI_REVIEW_PR=123
 *   PI_REVIEW_DIFF_FILE=/tmp/diff.txt   (or PI_REVIEW_DIFF=<inline text>)
 *   PI_REVIEW_PERSONA=quality
 *   LITELLM_API_KEY=...
 *   # optional:
 *   GITHUB_STEP_SUMMARY=/tmp/summary.md  (written by GitHub Actions)
 *   GITHUB_OUTPUT=/tmp/outputs.txt        (written by GitHub Actions)
 *
 * Resume: per (pr, persona) session JSONL is persisted under sessionsRoot.
 * Re-runs continue the session; the shared prefix hits DeepSeek's content
 * cache and usage.cacheRead > 0 is surfaced in the output.
 */
import { readFileSync } from "node:fs";
import { appendFileSync } from "node:fs";
import { createLiteLLMDeepSeekProvider } from "./provider.js";
import { runReview, type ReviewResult } from "./review.js";

interface CliOptions {
  pr: number;
  diffFile: string | undefined;
  diffInline: string | undefined;
  persona: string;
  baseURL: string;
  sessionsRoot: string;
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
  const persona = args.persona || process.env.PI_REVIEW_PERSONA || "";
  if (!persona) throw new Error("--persona <name> (or PI_REVIEW_PERSONA) required");
  return {
    pr,
    diffFile: args["diff-file"] || process.env.PI_REVIEW_DIFF_FILE,
    diffInline: process.env.PI_REVIEW_DIFF,
    persona,
    baseURL: args["base-url"] || process.env.LITELLM_BASE_URL || "https://llm.sun-praise.com/v1",
    sessionsRoot: args["sessions-root"] || process.env.PI_REVIEW_SESSIONS_ROOT || "./sessions",
    cwd: args.cwd || process.cwd(),
  };
}

function loadDiff(opts: CliOptions): string {
  if (opts.diffInline) return opts.diffInline;
  if (opts.diffFile) return readFileSync(opts.diffFile, "utf8");
  throw new Error("no diff source: set --diff-file, PI_REVIEW_DIFF_FILE, or PI_REVIEW_DIFF");
}

function writeStepSummary(result: ReviewResult, persona: string): void {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  const md =
    `### pi-review-agent — ${persona} (resumed=${result.resumed})\n\n` +
    `| metric | value |\n|---|---|\n` +
    `| input tokens | ${result.usage.input} |\n` +
    `| output tokens | ${result.usage.output} |\n` +
    `| **cacheRead** | **${result.usage.cacheRead}** (hit → discounted) |\n` +
    `| cacheWrite | ${result.usage.cacheWrite} |\n` +
    `| cost (USD) | $${result.usage.costTotal.toFixed(6)} |\n\n` +
    `<details><summary>review</summary>\n\n${result.content}\n\n</details>\n`;
  appendFileSync(path, md);
}

function writeOutputs(result: ReviewResult): void {
  const path = process.env.GITHUB_OUTPUT;
  if (!path) return;
  const lines = [
    `cacheRead=${result.usage.cacheRead}`,
    `costTotal=${result.usage.costTotal.toFixed(6)}`,
    `resumed=${result.resumed}`,
    `sessionId=${result.sessionId}`,
  ];
  appendFileSync(path, lines.join("\n") + "\n");
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);
  const diff = loadDiff(opts);

  const provider = createLiteLLMDeepSeekProvider({ baseURL: opts.baseURL });
  const result = await runReview({
    provider,
    pr: opts.pr,
    persona: opts.persona,
    diff,
    sessionsRoot: opts.sessionsRoot,
    cwd: opts.cwd,
  });

  process.stdout.write(`\n=== review (${opts.persona}, resumed=${result.resumed}) ===\n${result.content}\n`);
  process.stdout.write(
    `\n=== usage ===\n` +
      `input:       ${result.usage.input}\n` +
      `output:      ${result.usage.output}\n` +
      `cacheRead:   ${result.usage.cacheRead}  (hit → discounted billing)\n` +
      `cacheWrite:  ${result.usage.cacheWrite}\n` +
      `cost total:  $${result.usage.costTotal.toFixed(6)}\n`,
  );

  writeStepSummary(result, opts.persona);
  writeOutputs(result);
}

main().catch((err) => {
  console.error("pi-review-agent failed:", err);
  process.exit(1);
});
