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
import { resolveModelIds, DEFAULT_MODEL_ID } from "./model-ids.js";
import { parseArgs, type CliOptions } from "./parse-args.js";
import { formatCost, type CurrencyOptions } from "./currency.js";
import { runReview, type ReviewResult } from "./review.js";
import { runTeamReview, renderTeamComment, renderTeamReviewBody, buildSystemPrompt, type TeamReviewResult } from "./orchestrate.js";
import { loadPersonas } from "./personas.js";
import { loadStyleGuide } from "./style-guide.js";
import { createAdapterFromEnv, type PlatformAdapter } from "./platforms/index.js";
import { postTeamResults } from "./post-results.js";
import { filterDiff } from "./diff-filter.js";
import { parseSeverity, shouldFail } from "./severity.js";
import { parseFallbackModels } from "./fallback.js";
import { listDiffFiles } from "./changed-lines.js";
import { buildRelatedContext } from "./related-context.js";


function loadDiff(opts: CliOptions): string {
  if (opts.diffInline) return opts.diffInline;
  if (opts.diffFile) return readFileSync(opts.diffFile, "utf8");
  throw new Error("no diff source: set --diff-file, PI_REVIEW_DIFF_FILE, or PI_REVIEW_DIFF");
}

/**
 * Load + filter the diff. Lock files are always stripped; user globs add
 * to the exclusion. A byte budget keeps the payload inside the model's
 * context window. Logs what was dropped so the run summary reflects it.
 */
function prepareDiff(opts: CliOptions): string {
  const raw = loadDiff(opts);
  const r = filterDiff(raw, {
    excludePatterns: opts.diffExclude.length > 0 ? opts.diffExclude : undefined,
    maxSizeBytes: opts.diffMaxSizeKb > 0 ? opts.diffMaxSizeKb * 1024 : undefined,
    includeBuildArtifacts: opts.diffIncludeBuildArtifacts,
  });
  if (r.removedFiles.length > 0) {
    process.stderr.write(
      `diff-filter: dropped ${r.removedFiles.length} file(s): ${r.removedFiles.join(", ")}\n`,
    );
  }
  if (r.truncated) {
    process.stderr.write(
      `diff-filter: truncated to ${Math.round(r.filteredBytes / 1024)} KB after filtering\n`,
    );
  }
  return r.filtered;
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

function writeSingleSummary(result: ReviewResult, persona: string, currency: CurrencyOptions): void {
  const label = currency.currency.toUpperCase();
  const md =
    `### pi-review-agent — ${persona} (resumed=${result.resumed})\n\n` +
    `| metric | value |\n|---|---|\n` +
    `| input tokens | ${result.usage.input} |\n` +
    `| output tokens | ${result.usage.output} |\n` +
    `| **cacheRead** | **${result.usage.cacheRead}** (hit → discounted) |\n` +
    `| cacheWrite | ${result.usage.cacheWrite} |\n` +
    `| cost (${label}) | ${formatCost(result.usage.costTotal, currency)} |\n\n` +
    `<details><summary>review</summary>\n\n${result.content}\n\n</details>\n`;
  appendStepSummary(md);
}

function writeTeamSummary(
  result: TeamReviewResult,
  currency: CurrencyOptions,
  commentBody?: string,
): void {
  const label = currency.currency.toUpperCase();
  const lines: string[] = [];
  lines.push(`### pi-review-agent — team review (${result.personas.length} reviewers)`);
  lines.push("");
  lines.push(`| persona | resumed | input | output | cacheRead | cost (${label}) |`);
  lines.push("|---|---|---|---|---|---|");
  for (const r of result.personas) {
    lines.push(
      `| ${r.persona} | ${r.result.resumed} | ${r.result.usage.input} | ${r.result.usage.output} | ${r.result.usage.cacheRead} | ${formatCost(r.result.usage.costTotal, currency)} |`,
    );
  }
  if (result.coordinator) {
    lines.push(
      `| coordinator | ${result.coordinator.resumed} | ${result.coordinator.usage.input} | ${result.coordinator.usage.output} | ${result.coordinator.usage.cacheRead} | ${formatCost(result.coordinator.usage.costTotal, currency)} |`,
    );
  }
  lines.push("");
  lines.push(`**Verdict: ${result.verdict}**`);
  lines.push(
    `**Total cost: ${formatCost(result.totalCost, currency)} · cacheRead ${result.totalCacheRead}**`,
  );
  lines.push("");
  // Archive the full PR comment body (#62): the review surface now carries
  // only a slim digest, so the run log is where the full synthesis for a
  // given SHA remains retrievable long after the PR comment moved on.
  if (commentBody) {
    lines.push(`<details><summary>Full summary posted to the PR</summary>`);
    lines.push("");
    lines.push(commentBody);
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }
  appendStepSummary(lines.join("\n"));
  // Machine outputs stay USD regardless of the display currency (#57): the
  // existing consumers parse costTotal as dollars.
  appendOutputs([
    `verdict=${result.verdict}`,
    `totalCost=${result.totalCost.toFixed(6)}`,
    `totalCacheRead=${result.totalCacheRead}`,
  ]);
}


async function runSingle(opts: CliOptions): Promise<number> {
  const provider = createLiteLLMDeepSeekProvider({
    baseURL: opts.baseURL,
    // The primary must be defaulted HERE, not only in runReview: when --model
    // is unset, runReview still requests deepseek-v4-flash first, and
    // resolveModelIds only defaults an EMPTY list — fallbacks alone must not
    // crowd out the primary.
    modelIds: resolveModelIds([
      opts.modelId ?? DEFAULT_MODEL_ID,
      ...parseFallbackModels(opts.fallbackModels),
    ]),
    costByModel: opts.costByModel,
  });
  const personaName = opts.persona as string;
  const available = loadPersonas(opts.cwd);
  const persona = available.find((p) => p.name === personaName);
  const styleGuide = loadStyleGuide(opts.cwd, opts.styleGuide);
  const systemPrompt = persona ? buildSystemPrompt(persona, styleGuide) : undefined;
  const diff = prepareDiff(opts);
  const result = await runReview({
    provider,
    pr: opts.pr,
    persona: personaName,
    modelId: opts.modelId,
    fallbackModels: parseFallbackModels(opts.fallbackModels),
    diff,
    prContext: opts.prContext,
    relatedContext: opts.relatedContext,
    sessionsRoot: opts.sessionsRoot,
    cwd: opts.cwd,
    systemPrompt,
    language: opts.language,
    timeoutMs: opts.timeoutMs,
    maxAttempts: opts.maxAttempts,
    retryBackoffMs: opts.retryBackoffMs,
  });
  process.stdout.write(`\n=== review (${personaName}, resumed=${result.resumed}) ===\n${result.content}\n`);
  process.stdout.write(
    `cacheRead: ${result.usage.cacheRead}  cost: ${formatCost(result.usage.costTotal, opts.displayCurrency)}\n`,
  );
  writeSingleSummary(result, personaName, opts.displayCurrency);
  appendOutputs([
    `cacheRead=${result.usage.cacheRead}`,
    `costTotal=${result.usage.costTotal.toFixed(6)}`,
    `resumed=${result.resumed}`,
    `sessionId=${result.sessionId}`,
  ]);
  // Single-persona mode has no coordinator: parse severity straight from
  // the reviewer's output. The gate is fail-closed (unparseable → fail).
  const severity = parseSeverity(result.content);
  return shouldFail(severity, opts.failOnSeverity) ? 1 : 0;
}

async function runTeam(opts: CliOptions, adapter: PlatformAdapter): Promise<number> {
  const diff = prepareDiff(opts);
  // Per-role resolution: an unset override falls back to the reviewer model —
  // exactly the pre-per-role behavior (one model for every role).
  const reviewerModelId = opts.modelId ?? DEFAULT_MODEL_ID;
  const coordinatorModelId = opts.coordinatorModelId ?? reviewerModelId;
  const verifierModelId = opts.verifierModelId ?? reviewerModelId;
  if (opts.skipCoordinator && opts.coordinatorModelId) {
    process.stderr.write(
      "coordinator-model is set but skip-coordinator is enabled; the override has no effect\n",
    );
  }
  // Every id any role or fallback may request must be registered on the
  // provider — pi-ai's getModel() is a strict lookup, unregistered ids throw.
  const provider = createLiteLLMDeepSeekProvider({
    baseURL: opts.baseURL,
    modelIds: resolveModelIds([
      reviewerModelId,
      coordinatorModelId,
      verifierModelId,
      ...parseFallbackModels(opts.fallbackModels),
    ]),
    costByModel: opts.costByModel,
  });
  const result = await runTeamReview({
    provider,
    pr: opts.pr,
    diff,
    prContext: opts.prContext,
    relatedContext: opts.relatedContext,
    cwd: opts.cwd,
    sessionsRoot: opts.sessionsRoot,
    team: opts.team,
    modelId: opts.modelId,
    coordinatorModelId,
    verifierModelId,
    fallbackModels: parseFallbackModels(opts.fallbackModels),
    language: opts.language,
    skipCoordinator: opts.skipCoordinator,
    timeoutMs: opts.timeoutMs,
    maxAttempts: opts.maxAttempts,
    retryBackoffMs: opts.retryBackoffMs,
    styleGuide: opts.styleGuide,
    skipVerify: opts.skipVerify,
    skipLlmVerify: opts.skipLlmVerify,
  });
  process.stdout.write(`\n=== team review (${result.personas.length} personas) ===\n`);
  process.stdout.write(`verdict: ${result.verdict}\n`);
  process.stdout.write(
    `total cost: ${formatCost(result.totalCost, opts.displayCurrency)} · cacheRead ${result.totalCacheRead}\n`,
  );
  if (result.coordinator) {
    process.stdout.write(`\n--- coordinator ---\n${result.coordinator.content}\n`);
  }
  for (const r of result.personas) {
    process.stdout.write(`\n--- ${r.persona} ---\n${r.result.content}\n`);
  }
  const commentBody = renderTeamComment(result, { currency: opts.displayCurrency });
  writeTeamSummary(result, opts.displayCurrency, commentBody);

  // Post PR results using platform adapter
  const prInfo = adapter.resolvePrFromEnv(process.env);
  if (prInfo) {
    const reviewBody = renderTeamReviewBody(result, { currency: opts.displayCurrency });
    const commentContext = {
      apiBase: prInfo.apiBase,
      repository: prInfo.repository,
      pr: opts.pr,
      token: prInfo.token,
      headSha: prInfo.headSha,
    };
    // Inline findings + slim digest go out as a PR review; the full summary
    // comment is ALWAYS refreshed afterwards (post-results.ts explains the
    // policy and the two bodies).
    const outcome = await postTeamResults(adapter, commentContext, commentBody, reviewBody, result.inlineComments);
    process.stdout.write(`\nPR review: ${outcome.review ?? "none"}\nPR comment: ${outcome.comment}\n`);
  }
  return shouldFail(result.severity, opts.failOnSeverity) ? 1 : 0;
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv);

  // Create platform adapter with auto-detection
  const { adapter, platform } = await createAdapterFromEnv(process.env, opts.platform);
  process.stderr.write(`Using platform: ${platform}\n`);

  if (opts.includePrContext) {
    const prInfo = adapter.resolvePrFromEnv(process.env);
    if (prInfo) {
      opts.prContext = await adapter.fetchPrContext({
        apiBase: prInfo.apiBase,
        repository: prInfo.repository,
        pr: opts.pr,
        token: prInfo.token,
      });
    } else {
      process.stderr.write(
        "includePrContext enabled but platform env vars not configured; skipping context fetch\n",
      );
    }
  }
  // Related-files context: build a reverse-import graph over cwd and surface
  // the files that import the PR's changed files. Fail-open — any error leaves
  // relatedContext empty and the reviewer falls back to diff-only.
  if (opts.includeRelatedContext) {
    try {
      const diff = prepareDiff(opts);
      const changedFiles = listDiffFiles(diff);
      opts.relatedContext = await buildRelatedContext(changedFiles, opts.cwd);
    } catch (err: unknown) {
      process.stderr.write(
        `related context: failed (${err instanceof Error ? err.message : String(err)}); skipping\n`,
      );
    }
  }
  return opts.team ? runTeam(opts, adapter) : runSingle(opts);
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("pi-review-agent failed:", err);
    process.exit(1);
  });
