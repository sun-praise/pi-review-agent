import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveCurrencyOptions,
  formatCost,
  DEFAULT_USD_CNY_RATE,
} from "./currency.js";

describe("resolveCurrencyOptions", () => {
  it("unset → usd with default rate, no warnings", () => {
    const r = resolveCurrencyOptions(undefined, undefined);
    assert.deepEqual(r, { currency: "usd", rate: DEFAULT_USD_CNY_RATE, warnings: [] });
  });

  it("empty/whitespace strings (GitHub's unset representation) behave as unset", () => {
    for (const raw of ["", "  "]) {
      const r = resolveCurrencyOptions(raw, raw);
      assert.deepEqual(r, { currency: "usd", rate: DEFAULT_USD_CNY_RATE, warnings: [] });
    }
  });

  it("accepts cny case-insensitively and a positive rate override", () => {
    const r = resolveCurrencyOptions(" CNY ", "7.25");
    assert.deepEqual(r, { currency: "cny", rate: 7.25, warnings: [] });
  });

  it("unknown currency warns and falls back to usd", () => {
    const r = resolveCurrencyOptions("eur", undefined);
    assert.equal(r.currency, "usd");
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /eur/);
  });

  it("non-positive / non-numeric rate warns and falls back to the default", () => {
    for (const bad of ["0", "-7", "abc"]) {
      const r = resolveCurrencyOptions("cny", bad);
      assert.equal(r.rate, DEFAULT_USD_CNY_RATE);
      assert.match(r.warnings[0], /exchange-rate/);
    }
  });

  it("rate is accepted even when currency is usd (kept for later switch)", () => {
    const r = resolveCurrencyOptions("usd", "7.31");
    assert.deepEqual(r, { currency: "usd", rate: 7.31, warnings: [] });
  });
});

describe("formatCost", () => {
  it("usd renders with $ and six decimals (unchanged behavior)", () => {
    assert.equal(formatCost(0.000193, { currency: "usd", rate: 7.2 }), "$0.000193");
  });

  it("cny converts at the configured rate with ¥", () => {
    assert.equal(formatCost(0.000193, { currency: "cny", rate: 7.2 }), "¥0.001390");
    assert.equal(formatCost(1, { currency: "cny", rate: 7.25 }), "¥7.250000");
  });

  it("zero costs render in both currencies", () => {
    assert.equal(formatCost(0, { currency: "usd", rate: 7.2 }), "$0.000000");
    assert.equal(formatCost(0, { currency: "cny", rate: 7.2 }), "¥0.000000");
  });
});
