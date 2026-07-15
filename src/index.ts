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
import { runTeamReview, renderTeamComment, buildSystemPrompt, type TeamReviewResult } from "./orchestrate.js";
import { loadPersonas } from "./personas.js";
import { loadStyleGuide } from "./style-guide.js";
import { createAdapterFromEnv, type PlatformAdapter } from "./platforms/index.js";
import { filterDiff } from "./diff-filter.js";
import { parseSeverity, shouldFail, type FailMode } from "./severity.js";

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
  /** Output language for review prose. Default "zh" (中文). */
  language: string;
  /** Per-review hard timeout (ms). 0 = disable. Default 600000. */
  timeoutMs: number;
  /** Max attempts per review. Default 3. */
  maxAttempts: number;
  /** Retry backoff base (ms). Default 1000. */
  retryBackoffMs: number;
  /** Comma-separated globs to exclude from the diff (in addition to locks). */
  diffExclude: string[];
  /** Max diff size in KB after filtering. 0 = no limit. */
  diffMaxSizeKb: number;
  /** Keep build artifacts (dist/, build/, *.min.js, …) instead of excluding
   *  them by default. Opt-in; defaults to false. */
  diffIncludeBuildArtifacts: boolean;
  /** Fail-on-severity gate: "none" | "blocking" | "warning". */
  failOnSeverity: "none" | "blocking" | "warning";
  /** Fetch PR metadata (title/body/comments/reviews) and prepend to reviewer
   *  prompt. Default true. Set PI_REVIEW_INCLUDE_PR_CONTEXT=0/false to disable. */
  includePrContext: boolean;
  /** Populated in main() after parseArgs when includePrContext is on. Empty
   *  string = no context (fetch skipped, failed, or PR has no discussion). */
  prContext: string;
  /** Platform override: "github" | "gitea". Auto-detected if not set. */
  platform: string | undefined;
  /** Explicit path to a repository style-guide file, or undefined to auto-detect. */
  styleGuide: string | undefined;
  /** Skip the verifier entirely (both layers). Default false (verify on).
   *  Mirrors skip-coordinator's "1"/"true" truthiness convention. */
  skipVerify: boolean;
  /** Skip only the LLM verifier layer; the rule layer still runs. Default false. */
  skipLlmVerify: boolean;
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
    skipCoordinator:
      skipEnv === "1" || skipEnv?.toLowerCase() === "true" || args["skip-coordinator"] === "true",
    baseURL: args["base-url"] || process.env.LITELLM_BASE_URL || "https://llm.sun-praise.com",
    sessionsRoot: args["sessions-root"] || process.env.PI_REVIEW_SESSIONS_ROOT || "./sessions",
    language: args.language || process.env.PI_REVIEW_LANGUAGE || "zh",
    modelId: args.model || process.env.PI_REVIEW_MODEL,
    cwd: args.cwd || process.cwd(),
    timeoutMs: resolveTimeoutMs(args["timeout-seconds"], args["timeout-ms"], process.env),
    maxAttempts: intEnv(args["max-attempts"], process.env.PI_REVIEW_MAX_ATTEMPTS, 3),
    retryBackoffMs: intEnv(
      args["retry-backoff-ms"],
      process.env.PI_REVIEW_RETRY_BACKOFF_MS,
      1000,
    ),
    diffExclude: (args["diff-exclude"] || process.env.PI_REVIEW_DIFF_EXCLUDE || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    diffMaxSizeKb: intEnv(
      args["diff-max-size-kb"],
      process.env.PI_REVIEW_DIFF_MAX_SIZE_KB,
      200,
    ),
    diffIncludeBuildArtifacts: !/^(0|false|no|off)$/i.test(
      args["diff-include-build-artifacts"] ??
        process.env.PI_REVIEW_DIFF_INCLUDE_BUILD_ARTIFACTS ??
        "false",
    ),
    failOnSeverity: parseFailMode(
      args["fail-on-severity"] || process.env.PI_REVIEW_FAIL_ON_SEVERITY || "none",
    ),
    includePrContext: !/^(0|false|no|off)$/i.test(
      args["include-pr-context"] ?? process.env.PI_REVIEW_INCLUDE_PR_CONTEXT ?? "true",
    ),
    prContext: "",
    platform: args.platform || process.env.PI_REVIEW_PLATFORM,
    styleGuide: args["style-guide"] || process.env.PI_REVIEW_STYLE_GUIDE,
    skipVerify: isTruthyFlag(args["skip-verify"], process.env.PI_REVIEW_SKIP_VERIFY),
    skipLlmVerify: isTruthyFlag(args["skip-llm-verify"], process.env.PI_REVIEW_SKIP_LLM_VERIFY),
  };
}

/** Resolve a boolean skip-flag from a CLI arg or env var. Only "1"/"true"
 *  (case-insensitive) are truthy — mirroring the skip-coordinator convention so
 *  GitHub Actions' literal "false" string doesn't accidentally enable skipping. */
function isTruthyFlag(argVal: string | undefined, envVal: string | undefined): boolean {
  const raw = argVal ?? envVal;
  return raw === "1" || raw?.toLowerCase() === "true";
}

function intEnv(argVal: string | undefined, envVal: string | undefined, fallback: number): number {
  const raw = argVal || envVal;
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Resolve the per-review timeout. Inputs accept seconds (matching the
 * action.yml `timeout-seconds` input and opencode conventions); an explicit
 * ms flag/env exists for precise control. Returns ms; 0 disables. The
 * seconds→ms conversion is done here, NOT in action.yml expressions, because
 * GitHub Actions expression syntax can't do arithmetic on hyphenated input
 * names (parse-time failure).
 */
function resolveTimeoutMs(
  secArg: string | undefined,
  msArg: string | undefined,
  env: NodeJS.ProcessEnv,
): number {
  const secRaw = secArg || env.PI_REVIEW_TIMEOUT_SECONDS;
  if (secRaw !== undefined && secRaw !== "") {
    const sec = Number(secRaw);
    if (Number.isFinite(sec) && sec >= 0) return Math.round(sec * 1000);
  }
  const msRaw = msArg || env.PI_REVIEW_TIMEOUT_MS;
  if (msRaw !== undefined && msRaw !== "") {
    const ms = Number(msRaw);
    if (Number.isFinite(ms) && ms >= 0) return ms;
  }
  return 600_000;
}

function parseFailMode(raw: string): "none" | "blocking" | "warning" {
  return raw === "blocking" || raw === "warning" ? raw : "none";
}

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

async function runSingle(opts: CliOptions): Promise<number> {
  const provider = createLiteLLMDeepSeekProvider({ baseURL: opts.baseURL, modelId: opts.modelId });
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
    diff,
    prContext: opts.prContext,
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
    `cacheRead: ${result.usage.cacheRead}  cost: $${result.usage.costTotal.toFixed(6)}\n`,
  );
  writeSingleSummary(result, personaName);
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
  const provider = createLiteLLMDeepSeekProvider({ baseURL: opts.baseURL, modelId: opts.modelId });
  const result = await runTeamReview({
    provider,
    pr: opts.pr,
    diff,
    prContext: opts.prContext,
    cwd: opts.cwd,
    sessionsRoot: opts.sessionsRoot,
    team: opts.team,
    modelId: opts.modelId,
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
    `total cost: $${result.totalCost.toFixed(6)} · cacheRead ${result.totalCacheRead}\n`,
  );
  if (result.coordinator) {
    process.stdout.write(`\n--- coordinator ---\n${result.coordinator.content}\n`);
  }
  for (const r of result.personas) {
    process.stdout.write(`\n--- ${r.persona} ---\n${r.result.content}\n`);
  }
  writeTeamSummary(result);

  // Post PR comment using platform adapter
  const prInfo = adapter.resolvePrFromEnv(process.env);
  if (prInfo) {
    const body = renderTeamComment(result);
    const commentContext = {
      apiBase: prInfo.apiBase,
      repository: prInfo.repository,
      pr: opts.pr,
      token: prInfo.token,
      headSha: prInfo.headSha,
    };
    // When the coordinator surfaced line-pinned findings, post a review
    // with inline comments (falls back to summary comment on Gitea).
    // Otherwise keep the comment path with its edit-in-place behaviour.
    const outcome =
      result.inlineComments.length > 0
        ? await adapter.postReview(commentContext, body, result.inlineComments)
        : await adapter.postComment(commentContext, body);
    process.stdout.write(`\nPR comment: ${outcome}\n`);
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
  return opts.team ? runTeam(opts, adapter) : runSingle(opts);
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("pi-review-agent failed:", err);
    process.exit(1);
  });
