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
    });
    assert.equal(opts.diffIncludeBuildArtifacts, false);
    assert.equal(opts.includePrContext, true);
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
