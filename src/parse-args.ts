/**
 * CLI/env option parsing, extracted from index.ts so it is unit-testable:
 * index.ts executes main() on import and cannot be loaded by `node --test`.
 * This module is pure — it reads only the argv/env it is handed, no fs, no
 * pi-ai imports.
 *
 * Empty-string normalization (#48): GitHub Actions injects every env var as
 * a string, so an UNSET optional input arrives as "" — not nullish, and it
 * used to slip past `??` fallbacks downstream as a blank value (e.g. a blank
 * model id reaching the provider lookup). All optional strings are therefore
 * normalized here: unset, empty, and whitespace-only all become `undefined`,
 * so downstream `??`/`||` semantics hold. Two deliberate exceptions where ""
 * is a meaningful value: `fallback-models` ("" disables the chain, see
 * action.yml) and `cost-overrides` ("" = no overrides).
 */
import { parseCostOverrides, type ModelCostTable } from "./model-cost.js";

export interface CliOptions {
  pr: number;
  diffFile: string | undefined;
  diffInline: string | undefined;
  persona: string | undefined;
  team: string | undefined;
  skipCoordinator: boolean;
  baseURL: string;
  sessionsRoot: string;
  modelId: string | undefined;
  /** Per-role override: coordinator model id. Undefined → fall back to modelId. */
  coordinatorModelId: string | undefined;
  /** Per-role override: LLM-verifier model id. Undefined → fall back to modelId. */
  verifierModelId: string | undefined;
  /** Comma-separated fallback model ids. Empty string = disable the chain. */
  fallbackModels: string | undefined;
  /** Parsed per-id cost tables from --cost-overrides / PI_REVIEW_COST_OVERRIDES.
   *  Empty map = all ids billed at the DeepSeek default estimate. Invalid
   *  input warns on stderr and degrades to the default (never fails a run). */
  costByModel: Record<string, ModelCostTable>;
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
  /** Whether to compute and inject related-files context. Default true.
   *  Set PI_REVIEW_SKIP_RELATED_CONTEXT=1/true to disable. */
  includeRelatedContext: boolean;
  /** Populated in main() after the import graph is built. Empty string when
   *  disabled, no changed files, or graph building failed (fail-open). */
  relatedContext: string;
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

/**
 * Resolve an optional string option from a CLI arg (preferred) and an env
 * var. Unset, empty, and whitespace-only values all collapse to undefined —
 * applied uniformly across call sites so the GitHub-Actions ""-injection
 * quirk can never produce a blank-but-defined value downstream.
 */
function optionalString(argVal: string | undefined, envVal: string | undefined): string | undefined {
  for (const val of [argVal, envVal]) {
    if (val !== undefined && val.trim()) return val;
  }
  return undefined;
}

/** Parse --cost-overrides JSON into per-id cost tables; warn and degrade to
 *  an empty map on invalid input so a bad cost config never fails a run —
 *  summaries just fall back to the DeepSeek default estimate. */
function resolveCostOverrides(raw: string | undefined): Record<string, ModelCostTable> {
  const parsed = parseCostOverrides(raw);
  if (parsed.ok) return parsed.costs;
  process.stderr.write(`cost-overrides ignored: ${parsed.error}\n`);
  return {};
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i += 2) {
    const k = argv[i]?.replace(/^--/, "");
    args[k ?? ""] = argv[i + 1] ?? "";
  }
  const pr = Number(args.pr || env.PI_REVIEW_PR || 0);
  if (!Number.isFinite(pr) || pr <= 0) {
    throw new Error(`--pr <number> (or PI_REVIEW_PR) required`);
  }
  const persona = optionalString(args.persona, env.PI_REVIEW_PERSONA);
  const team = optionalString(args.team, env.PI_REVIEW_TEAM);
  // GitHub Actions always injects env vars as strings, so the literal "false"
  // from action.yml inputs.skip-coordinator must NOT be truthy. Only "1"/"true"
  // (case-insensitive) enable skipping.
  const skipEnv = env.PI_REVIEW_SKIP_COORDINATOR;
  if (!persona && !team) {
    throw new Error("--persona <name> or --team <spec> required");
  }
  // An explicitly-empty --model/PI_REVIEW_MODEL is almost certainly a config
  // mistake; before #48 it silently dropped the primary model and the run
  // fell through to the fallback chain. Fail loudly instead.
  const modelRaw = args.model !== undefined ? args.model : env.PI_REVIEW_MODEL;
  if (modelRaw !== undefined && !modelRaw.trim()) {
    throw new Error("--model (or PI_REVIEW_MODEL) must not be empty — unset it to use the default model");
  }
  return {
    pr,
    diffFile: optionalString(args["diff-file"], env.PI_REVIEW_DIFF_FILE),
    diffInline: optionalString(undefined, env.PI_REVIEW_DIFF),
    persona,
    team,
    skipCoordinator:
      skipEnv === "1" || skipEnv?.toLowerCase() === "true" || args["skip-coordinator"] === "true",
    baseURL: optionalString(args["base-url"], env.LITELLM_BASE_URL) ?? "https://llm.sun-praise.com",
    sessionsRoot: optionalString(args["sessions-root"], env.PI_REVIEW_SESSIONS_ROOT) ?? "./sessions",
    language: optionalString(args.language, env.PI_REVIEW_LANGUAGE) ?? "zh",
    modelId: optionalString(args.model, env.PI_REVIEW_MODEL),
    coordinatorModelId: optionalString(
      args["coordinator-model"],
      env.PI_REVIEW_COORDINATOR_MODEL,
    ),
    verifierModelId: optionalString(args["verifier-model"], env.PI_REVIEW_VERIFIER_MODEL),
    costByModel: resolveCostOverrides(args["cost-overrides"] ?? env.PI_REVIEW_COST_OVERRIDES),
    // "" is meaningful here (disable the fallback chain) — NOT normalized.
    fallbackModels: args["fallback-models"] ?? env.PI_REVIEW_FALLBACK_MODELS ?? "mimo-v2.5",
    cwd: args.cwd?.trim() ? args.cwd : process.cwd(),
    timeoutMs: resolveTimeoutMs(args["timeout-seconds"], args["timeout-ms"], env),
    maxAttempts: intEnv(args["max-attempts"], env.PI_REVIEW_MAX_ATTEMPTS, 3),
    retryBackoffMs: intEnv(args["retry-backoff-ms"], env.PI_REVIEW_RETRY_BACKOFF_MS, 1000),
    diffExclude: (optionalString(args["diff-exclude"], env.PI_REVIEW_DIFF_EXCLUDE) ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    diffMaxSizeKb: intEnv(args["diff-max-size-kb"], env.PI_REVIEW_DIFF_MAX_SIZE_KB, 200),
    // Negated-regex booleans MUST go through optionalString: GH's ""-injection
    // is not nullish, and "" matches neither the falsy pattern nor anything
    // else — without normalization an unset input inverts the documented
    // default ("" → !falsy-match → true). Found by dogfood review on this PR.
    diffIncludeBuildArtifacts: !/^(0|false|no|off)$/i.test(
      optionalString(args["diff-include-build-artifacts"], env.PI_REVIEW_DIFF_INCLUDE_BUILD_ARTIFACTS) ??
        "false",
    ),
    failOnSeverity: parseFailMode(
      optionalString(args["fail-on-severity"], env.PI_REVIEW_FAIL_ON_SEVERITY) ?? "none",
    ),
    includePrContext: !/^(0|false|no|off)$/i.test(
      optionalString(args["include-pr-context"], env.PI_REVIEW_INCLUDE_PR_CONTEXT) ?? "true",
    ),
    prContext: "",
    // Related context is on by default; flip via --skip-related-context or env.
    // Uses the "1"/"true" truthiness convention (like skip-coordinator) so a
    // literal "false" string from action.yml doesn't accidentally disable it.
    includeRelatedContext: !isTruthyFlag(
      args["skip-related-context"],
      env.PI_REVIEW_SKIP_RELATED_CONTEXT,
    ),
    relatedContext: "",
    platform: optionalString(args.platform, env.PI_REVIEW_PLATFORM),
    styleGuide: optionalString(args["style-guide"], env.PI_REVIEW_STYLE_GUIDE),
    skipVerify: isTruthyFlag(args["skip-verify"], env.PI_REVIEW_SKIP_VERIFY),
    skipLlmVerify: isTruthyFlag(args["skip-llm-verify"], env.PI_REVIEW_SKIP_LLM_VERIFY),
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
