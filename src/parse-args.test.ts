import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, type CliOptions } from "./parse-args.js";

/** Build argv the way parseArgs expects (options start at index 2). */
function parse(flags: string[], env: Record<string, string> = {}): CliOptions {
  return parseArgs(["node", "index.ts", ...flags], env);
}

const MIN = ["--pr", "1", "--persona", "quality"];

describe("parseArgs required options", () => {
  it("throws without --pr", () => {
    assert.throws(() => parse(["--persona", "quality"]), /--pr/);
  });

  it("throws without persona and team", () => {
    assert.throws(() => parse(["--pr", "1"]), /--persona|--team/);
  });
});

describe("parseArgs empty-string normalization (#48)", () => {
  it("modelId: unset → undefined; env value wins when arg unset", () => {
    assert.equal(parse(MIN).modelId, undefined);
    assert.equal(parse(MIN, { PI_REVIEW_MODEL: "mimo-v2.5" }).modelId, "mimo-v2.5");
  });

  it("modelId: explicitly empty (CLI or env) fails loudly instead of silently dropping the primary", () => {
    assert.throws(() => parse(["--pr", "1", "--persona", "quality", "--model", ""]), /--model/);
    assert.throws(() => parse(MIN, { PI_REVIEW_MODEL: "" }), /--model/);
    assert.throws(() => parse(MIN, { PI_REVIEW_MODEL: "   " }), /--model/);
  });

  it("GitHub's empty-string env for optional model overrides collapses to undefined", () => {
    const opts = parse(MIN, {
      PI_REVIEW_COORDINATOR_MODEL: "",
      PI_REVIEW_VERIFIER_MODEL: "",
    });
    assert.equal(opts.coordinatorModelId, undefined);
    assert.equal(opts.verifierModelId, undefined);
  });

  it("optional strings: empty env → undefined; CLI arg overrides env", () => {
    const opts = parse(MIN, {
      PI_REVIEW_STYLE_GUIDE: "",
      PI_REVIEW_PLATFORM: "",
      PI_REVIEW_DIFF_FILE: "",
      PI_REVIEW_COORDINATOR_MODEL: "strong-model",
    });
    assert.equal(opts.styleGuide, undefined);
    assert.equal(opts.platform, undefined);
    assert.equal(opts.diffFile, undefined);
    assert.equal(opts.coordinatorModelId, "strong-model");

    const overridden = parse([...MIN, "--coordinator-model", "cli-model"], {
      PI_REVIEW_COORDINATOR_MODEL: "env-model",
    });
    assert.equal(overridden.coordinatorModelId, "cli-model");
  });

  it("negated-regex booleans: empty env falls to the documented default, not inverted", () => {
    // GH injects "" for unset inputs; "" ?? "false" used to yield "" which
    // matched neither the falsy pattern nor anything else — inverting the
    // default to true (found by dogfood review).
    const opts = parse(MIN, {
      PI_REVIEW_DIFF_INCLUDE_BUILD_ARTIFACTS: "",
      PI_REVIEW_INCLUDE_PR_CONTEXT: "",
      PI_REVIEW_STATS_ENABLED: "",
    });
    assert.equal(opts.diffIncludeBuildArtifacts, false);
    assert.equal(opts.includePrContext, true);
    // GH's ""-injection must not flip the opt-in default to on.
    assert.equal(opts.statsEnabled, false);
  });

  it("explicit opt-in values still work through the normalization", () => {
    assert.equal(
      parse(MIN, { PI_REVIEW_DIFF_INCLUDE_BUILD_ARTIFACTS: "true" }).diffIncludeBuildArtifacts,
      true,
    );
    assert.equal(
      parse(MIN, { PI_REVIEW_DIFF_INCLUDE_BUILD_ARTIFACTS: "0" }).diffIncludeBuildArtifacts,
      false,
    );
    assert.equal(parse(MIN, { PI_REVIEW_INCLUDE_PR_CONTEXT: "false" }).includePrContext, false);
  });

  it("stats: opt-in — off by default, on only via 1/true (env or flag)", () => {
    assert.equal(parse(MIN).statsEnabled, false);
    for (const truthy of ["1", "true", "TRUE"]) {
      assert.equal(parse(MIN, { PI_REVIEW_STATS_ENABLED: truthy }).statsEnabled, true);
    }
    assert.equal(parse([...MIN, "--stats-enabled", "true"]).statsEnabled, true);
    for (const off of ["", "0", "false", "no"]) {
      assert.equal(parse(MIN, { PI_REVIEW_STATS_ENABLED: off }).statsEnabled, false);
    }
  });

  it("defaulted strings: empty env falls back to the default", () => {
    const opts = parse(MIN, { LITELLM_BASE_URL: "", PI_REVIEW_LANGUAGE: "", PI_REVIEW_SESSIONS_ROOT: "" });
    assert.equal(opts.baseURL, "https://llm.sun-praise.com");
    assert.equal(opts.language, "zh");
    assert.equal(opts.sessionsRoot, "./sessions");
  });

  it("fallback-models: empty string is MEANINGFUL (disables the chain), not normalized", () => {
    assert.equal(parse(MIN).fallbackModels, "mimo-v2.5");
    assert.equal(parse(MIN, { PI_REVIEW_FALLBACK_MODELS: "" }).fallbackModels, "");
    assert.equal(parse([...MIN, "--fallback-models", ""]).fallbackModels, "");
  });

  it("cost-overrides: empty env → empty map; invalid JSON degrades to empty map", () => {
    assert.deepEqual(parse(MIN, { PI_REVIEW_COST_OVERRIDES: "" }).costByModel, {});
    assert.deepEqual(parse(MIN, { PI_REVIEW_COST_OVERRIDES: '{"a":' }).costByModel, {});
  });
});

describe("parseArgs display currency (#57)", () => {
  it("unset / empty env → usd with the default rate (GitHub's \"\" behaves as unset)", () => {
    for (const env of [undefined, { PI_REVIEW_CURRENCY: "", PI_REVIEW_EXCHANGE_RATE: "" }]) {
      const opts = parse(MIN, env ?? {});
      assert.deepEqual(opts.displayCurrency, { currency: "usd", rate: 7.2 });
    }
  });

  it("cny + explicit rate", () => {
    const opts = parse(MIN, { PI_REVIEW_CURRENCY: "cny", PI_REVIEW_EXCHANGE_RATE: "7.31" });
    assert.deepEqual(opts.displayCurrency, { currency: "cny", rate: 7.31 });
  });

  it("CLI flags take precedence over env", () => {
    const opts = parse([...MIN, "--currency", "cny"], { PI_REVIEW_CURRENCY: "usd" });
    assert.equal(opts.displayCurrency.currency, "cny");
  });

  it("invalid currency or rate falls back with the parsed default (fail-open)", () => {
    const bad = parse(MIN, { PI_REVIEW_CURRENCY: "eur", PI_REVIEW_EXCHANGE_RATE: "abc" });
    assert.deepEqual(bad.displayCurrency, { currency: "usd", rate: 7.2 });
  });
});

describe("parseArgs flags and numbers", () => {
  it("GitHub's literal 'false' string never enables a skip flag", () => {
    const opts = parse(MIN, { PI_REVIEW_SKIP_COORDINATOR: "false" });
    assert.equal(opts.skipCoordinator, false);
    const on = parse(MIN, { PI_REVIEW_SKIP_COORDINATOR: "true" });
    assert.equal(on.skipCoordinator, true);
  });

  it("skip-verify / skip-llm-verify use the same truthiness convention", () => {
    assert.equal(parse(MIN).skipVerify, false);
    assert.equal(parse(MIN, { PI_REVIEW_SKIP_VERIFY: "1" }).skipVerify, true);
    assert.equal(parse(MIN, { PI_REVIEW_SKIP_VERIFY: "false" }).skipVerify, false);
  });

  it("timeout-seconds 0 disables the timeout; bad values fall back to 600s", () => {
    assert.equal(parse([...MIN, "--timeout-seconds", "0"]).timeoutMs, 0);
    assert.equal(parse([...MIN, "--timeout-seconds", "30"]).timeoutMs, 30_000);
    assert.equal(parse(MIN).timeoutMs, 600_000);
  });

  it("diff-exclude splits, trims, and drops empty segments", () => {
    assert.deepEqual(parse([...MIN, "--diff-exclude", " *.ts ,, vendor/** "]).diffExclude, [
      "*.ts",
      "vendor/**",
    ]);
  });

  it("fail-on-severity rejects unknown values to 'none'", () => {
    assert.equal(parse(MIN, { PI_REVIEW_FAIL_ON_SEVERITY: "blocking" }).failOnSeverity, "blocking");
    assert.equal(parse(MIN, { PI_REVIEW_FAIL_ON_SEVERITY: "bogus" }).failOnSeverity, "none");
  });
});

describe("parseArgs --format json (headless bench mode)", () => {
  const JSON_MIN = ["--format", "json", "--persona", "quality"];

  it("defaults to text; --format json / PI_REVIEW_FORMAT are honored (case-insensitive)", () => {
    assert.equal(parse(MIN).format, "text");
    assert.equal(parse([...MIN, "--format", "json"]).format, "json");
    assert.equal(parse(MIN, { PI_REVIEW_FORMAT: "JSON" }).format, "json");
  });

  it("rejects unknown format values loudly", () => {
    assert.throws(() => parse([...MIN, "--format", "jsn"]), /--format/);
  });

  it("--pr is optional in json mode (invalid values normalize to 0) but required in text mode", () => {
    assert.equal(parse(JSON_MIN).pr, 0);
    assert.equal(parse([...JSON_MIN, "--pr", "-1"]).pr, 0);
    assert.ok(Number.isNaN(parse(["--format", "json", "--persona", "q", "--pr", "abc"]).pr) === false);
    assert.throws(() => parse(["--persona", "quality"]), /--pr/);
  });

  it("output resolves from CLI and env, normalized like other optionals", () => {
    assert.equal(parse(JSON_MIN).output, undefined);
    assert.equal(parse([...JSON_MIN, "--output", "out.json"]).output, "out.json");
    assert.equal(parse(JSON_MIN, { PI_REVIEW_OUTPUT: " " }).output, undefined);
  });

  it("generates a random bench-* session key for keyless json runs (at parse time)", () => {
    assert.match(parse(JSON_MIN).sessionKey ?? "", /^bench-[0-9a-f-]{36}$/);
    // text mode never gets a synthetic key
    assert.equal(parse(MIN).sessionKey, undefined);
    // an explicit key always wins, from CLI or env
    assert.equal(
      parse([...JSON_MIN, "--session-key", "aacr__instance-42"]).sessionKey,
      "aacr__instance-42",
    );
    assert.equal(parse(JSON_MIN, { PI_REVIEW_SESSION_KEY: "bench-7" }).sessionKey, "bench-7");
    // json mode with a real --pr and no key keeps pr-based identity
    assert.equal(parse([...JSON_MIN, "--pr", "9"]).sessionKey, undefined);
  });
});
