/**
 * Review-agent entry. Three modes:
 *
 * Single-persona CLI:
 *   tsx src/index.ts --pr 123 --diff-file ./diff.txt --persona quality
 *
 * Team mode (multi-persona + coordinator + PR comment):
 *   tsx src/index.ts --pr 123 --diff-file ./diff.txt --team "quality:1,security:1"
 *   # in a GitHub Action the PR comment is posted automatically when
 *   # GITHUB_TOKEN + GITHUB_REF are set.
 *
 * Headless JSON mode (benchmarks / harnesses):
 *   tsx src/index.ts --format json --diff-file ./diff.txt \
 *     --team "quality:1,security:1" --session-key <instance-id> [--output out.json]
 *   # no --pr, no platform env, no PR comment; structured findings + usage
 *   # as one JSON payload; exit code reflects only process failure (the
 *   # fail-on-severity gate is a CI-posting concern, not a bench one).
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
import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
import { buildStatsEvent, recordStats, resolveRunIdentity } from "./stats.js";
import { checkWorkspace } from "./workspace-check.js";
import { buildSingleJsonResult, buildTeamJsonResult, type JsonRunResult } from "./json-output.js";
import { resolveSessionDirName } from "./session-dir.js";


function loadDiff(opts: CliOptions): string {
  if (opts.diffInline) return opts.diffInline;
  if (opts.diffFile) return readFileSync(opts.diffFile, "utf8");
  throw new Error("no diff source: set --diff-file, PI_REVIEW_DIFF_FILE, or PI_REVIEW_DIFF");
}

/**
 * Load + filter the diff. Lock files are always stripped; user globs add
 * to the exclusion. A byte budget keeps the payload inside the model's
 * context window. Logs what was dropped so the run summary reflects it.
 *
 * Memoized per opts object: one main() run calls this from the stale-tree
 * guard, the related-context builder, and runSingle/runTeam — same input,
 * same result, so re-parses and repeated stderr progress lines past the
 * first call are pure waste (dogfood review of #68: up to 4 full
 * re-parses, linear in diff size). CliOptions is immutable from here on.
 */
const preparedDiffCache = new WeakMap<CliOptions, string>();

function prepareDiff(opts: CliOptions): string {
  const cached = preparedDiffCache.get(opts);
  if (cached !== undefined) return cached;
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
  preparedDiffCache.set(opts, r.filtered);
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

/** Emit the JSON run payload. Delivery: --output file when given — on write
 *  failure we fall back to stdout (the review already completed; losing the
 *  payload would waste the tokens) and report failure so the exit code still
 *  tells the caller their contract (--output) broke. Without --output,
 *  stdout is the contract (single JSON document, diagnostics on stderr).
 *  Returns true when the requested channel succeeded. */
function writeJsonRunResult(payload: JsonRunResult, output: string | undefined): boolean {
  const text = JSON.stringify(payload, null, 2);
  if (output) {
    try {
      writeFileSync(output, text + "\n");
      process.stderr.write(`json output written to ${output}\n`);
      return true;
    } catch (err: unknown) {
      process.stderr.write(
        `json output to ${output} failed (${err instanceof Error ? err.message : String(err)}); falling back to stdout\n`,
      );
    }
  }
  process.stdout.write(text + "\n");
  return output === undefined;
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


async function runSingle(
  opts: CliOptions,
  adapter: PlatformAdapter | null,
  platform: string,
): Promise<number> {
  const startedAt = Date.now();
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
    sessionKey: opts.sessionKey,
    cwd: opts.cwd,
    systemPrompt,
    language: opts.language,
    timeoutMs: opts.timeoutMs,
    maxAttempts: opts.maxAttempts,
    retryBackoffMs: opts.retryBackoffMs,
  });
  // Single-persona mode has no coordinator: parse severity straight from
  // the reviewer's output. The gate is fail-closed (unparseable → fail).
  const severity = parseSeverity(result.content);
  // Stats emission is opt-in (stats-enabled, default off) and strictly
  // fail-open (see stats.ts) — a stats problem can never mask a review.
  // Works headless too (json mode passes a null adapter; repository falls
  // back to env or "local").
  const prInfo = adapter ? adapter.resolvePrFromEnv(process.env) : null;
  if (opts.statsEnabled) {
    const repository = prInfo?.repository ?? process.env.GITHUB_REPOSITORY?.trim() ?? "local";
    await recordStats({
      file: join(opts.sessionsRoot, "stats.jsonl"),
      url: opts.statsUrl,
      token: opts.statsToken,
      event: buildStatsEvent({
        platform,
        repository,
        pr: opts.pr,
        ...resolveRunIdentity(process.env),
        mode: "single",
        personas: [{ name: personaName, usage: result.usage, resumed: result.resumed }],
        coordinator: null,
        verdict: null,
        severity: {
          decision: severity.decision,
          blocking: severity.blockingCount,
          warning: severity.warningCount,
          fallback: severity.fallback,
        },
        durationMs: Date.now() - startedAt,
      }),
    });
  }
  if (opts.format === "json") {
    const delivered = writeJsonRunResult(
      buildSingleJsonResult({
        pr: opts.pr,
        // The payload reports the sanitized directory name actually used on
        // disk (single source of truth: session-dir.ts), so the field can
        // never disagree with the filesystem.
        sessionKey:
          opts.sessionKey !== undefined
            ? resolveSessionDirName(opts.sessionKey, opts.pr)
            : undefined,
        persona: personaName,
        result,
        severity,
      }),
      opts.output,
    );
    return delivered ? 0 : 1;
  }
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
  return shouldFail(severity, opts.failOnSeverity) ? 1 : 0;
}

async function runTeam(
  opts: CliOptions,
  adapter: PlatformAdapter | null,
  platform: string,
): Promise<number> {
  const startedAt = Date.now();
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
    sessionKey: opts.sessionKey,
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
  // Stats emission (opt-in via stats-enabled) before PR posting (fail-open):
  // a posting failure must not lose the run's token/cost record — the review
  // itself already succeeded. Runs in json mode too (null adapter → repository
  // falls back to env or "local").
  const prInfo = adapter ? adapter.resolvePrFromEnv(process.env) : null;
  if (opts.statsEnabled) {
    const repository = prInfo?.repository ?? process.env.GITHUB_REPOSITORY?.trim() ?? "local";
    await recordStats({
      file: join(opts.sessionsRoot, "stats.jsonl"),
      url: opts.statsUrl,
      token: opts.statsToken,
      event: buildStatsEvent({
        platform,
        repository,
        pr: opts.pr,
        ...resolveRunIdentity(process.env),
        mode: "team",
        personas: result.personas.map((p) => ({
          name: p.persona,
          usage: p.result.usage,
          resumed: p.result.resumed,
          error: p.error,
        })),
        coordinator: result.coordinator
          ? { name: "coordinator", usage: result.coordinator.usage, resumed: result.coordinator.resumed }
          : null,
        verdict: result.verdict,
        severity: {
          decision: result.severity.decision,
          blocking: result.severity.blockingCount,
          warning: result.severity.warningCount,
          fallback: result.severity.fallback,
        },
        durationMs: Date.now() - startedAt,
      }),
    });
  }

  // Headless exit: structured payload instead of the human report / step
  // summary / PR posting / severity exit gate. The gate stays a text-mode
  // concern — a benchmark harness must not read "verdict: CANNOT MERGE" as
  // a process failure (missing_instances vs empty-findings ambiguity).
  if (opts.format === "json") {
    const delivered = writeJsonRunResult(
      buildTeamJsonResult({
        pr: opts.pr,
        // Sanitized directory name actually used on disk (session-dir.ts).
        sessionKey:
          opts.sessionKey !== undefined
            ? resolveSessionDirName(opts.sessionKey, opts.pr)
            : undefined,
        result,
      }),
      opts.output,
    );
    return delivered ? 0 : 1;
  }

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
  if (prInfo && adapter) {
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

/** Best-effort related-files context (shared by both formats): build a
 *  reverse-import graph over cwd and surface the files that import the PR's
 *  changed files. Fail-open — any error leaves relatedContext empty and the
 *  reviewer falls back to diff-only. */
async function attachRelatedContext(opts: CliOptions): Promise<void> {
  if (!opts.includeRelatedContext) return;
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

async function main(): Promise<number> {
  const opts = parseArgs(process.argv);

  // Misconfig warnings live HERE (not parseArgs) to keep the module pure —
  // same pattern as the coordinator-model/skip-coordinator warning. A url
  // that can never ship, or a token that can never be used, would otherwise
  // fail silently.
  if (opts.statsUrl && !opts.statsEnabled) {
    process.stderr.write(
      "stats-url is set but stats is disabled; set stats-enabled to true to record stats events\n",
    );
  }
  if (opts.statsToken && !opts.statsUrl) {
    process.stderr.write("stats-token is set but stats-url is not; the token is never used\n");
  }

  // Stale-tree guard (#67): reviewers' read/grep, the related-context graph,
  // and the verifier's disk checks all read `cwd` — the caller's checkout.
  // If files the PR ADDS are missing there, cwd is provably not the PR head
  // (typical: self-hosted runner whose workspace still holds the previous
  // job's checkout because the review workflow has no checkout step), and
  // every tree read would feed reviewers stale facts. Fail closed with
  // actionable guidance instead of reviewing a stale tree. First thing in
  // main() — before platform detection and any network or LLM work — so the
  // failure is as cheap as it can be.
  let guardDiff: string | undefined;
  try {
    guardDiff = prepareDiff(opts);
  } catch {
    // No diff source at all — swallow here and let runSingle/runTeam throw
    // the same "no diff source" error in a moment; the guard has nothing
    // to check. (Relying on that later re-raise is why this catch is
    // silent rather than diagnostic.)
  }
  if (guardDiff !== undefined) {
    const guard = await checkWorkspace(guardDiff, opts.cwd);
    if (!guard.ok) {
      throw new Error(
        `workspace is not the PR head tree: ${guard.missing.length} file(s) added by the PR ` +
          `are missing under ${opts.cwd}:\n` +
          `${guard.missing.map((f) => `  - ${f}`).join("\n")}\n` +
          `Reviewing anyway would feed reviewers and the verifier a stale tree ` +
          `(issue #67). Fix: add an actions/checkout step before this action ` +
          `(self-hosted runners reuse the workspace across jobs, so it may still ` +
          `hold the previous job's checkout), or point working-directory at a ` +
          `checkout of the PR head.`,
      );
    }
  }

  // Related context is local-fs only (no platform), so it serves both the
  // text and the headless json path — compute it once, before the split.
  await attachRelatedContext(opts);

  // Headless json mode: no platform adapter is created (and none may be
  // detectable — bench harnesses run outside GitHub/Gitea env), no PR
  // context is fetched, no comment is posted. Bench isolation (random
  // bench-* session key when no pr/key given) is resolved in parseArgs, so
  // CliOptions stays immutable from construction on.
  if (opts.format === "json") {
    return opts.team ? runTeam(opts, null, "none") : runSingle(opts, null, "none");
  }

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
  return opts.team ? runTeam(opts, adapter, platform) : runSingle(opts, adapter, platform);
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("pi-review-agent failed:", err);
    process.exit(1);
  });
