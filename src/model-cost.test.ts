import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCostOverrides, DEFAULT_DEEPSEEK_COST } from "./model-cost.js";

describe("parseCostOverrides", () => {
  it("parses empty/undefined/whitespace to an empty map", () => {
    for (const raw of [undefined, "", "  "]) {
      const result = parseCostOverrides(raw);
      assert.ok(result.ok);
      assert.deepEqual(result.costs, {});
    }
  });

  it("parses a full table per model id", () => {
    const result = parseCostOverrides(
      '{"glm-5.3":{"input":0.6,"output":2.2,"cacheRead":0.1,"cacheWrite":0.2}}',
    );
    assert.ok(result.ok);
    assert.deepEqual(result.costs["glm-5.3"], {
      input: 0.6,
      output: 2.2,
      cacheRead: 0.1,
      cacheWrite: 0.2,
    });
  });

  it("defaults cacheRead/cacheWrite to 0 when omitted", () => {
    const result = parseCostOverrides('{"mimo-v2.5":{"input":0.1,"output":0.3}}');
    assert.ok(result.ok);
    assert.deepEqual(result.costs["mimo-v2.5"], {
      input: 0.1,
      output: 0.3,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it("parses multiple entries", () => {
    const result = parseCostOverrides(
      '{"a":{"input":1,"output":2},"b":{"input":3,"output":4,"cacheRead":0.5}}',
    );
    assert.ok(result.ok);
    assert.deepEqual(Object.keys(result.costs), ["a", "b"]);
  });

  it("accepts zero prices (free models are legitimate)", () => {
    const result = parseCostOverrides('{"free":{"input":0,"output":0}}');
    assert.ok(result.ok);
    assert.deepEqual(result.costs.free, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("rejects negative prices", () => {
    const result = parseCostOverrides('{"glm":{"input":-5,"output":2}}');
    assert.ok(!result.ok);
    assert.match(result.error, /finite non-negative/);
  });

  it("rejects Infinity (JSON 1e999) prices", () => {
    const result = parseCostOverrides('{"glm":{"input":1e999,"output":2}}');
    assert.ok(!result.ok);
    assert.match(result.error, /finite non-negative/);
  });

  it("rejects negative or infinite optional cache rates too", () => {
    const neg = parseCostOverrides('{"a":{"input":1,"output":2,"cacheRead":-0.1}}');
    assert.ok(!neg.ok);
    const inf = parseCostOverrides('{"a":{"input":1,"output":2,"cacheWrite":1e999}}');
    assert.ok(!inf.ok);
  });

  it("rejects __proto__/constructor/prototype keys (prototype-setter hazard)", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const result = parseCostOverrides(`{"${key}":{"input":1,"output":2}}`);
      assert.ok(!result.ok, key);
      assert.match(result.error, /not a valid model id/);
    }
  });

  it("rejects invalid JSON with an error message", () => {
    const result = parseCostOverrides('{"a":');
    assert.ok(!result.ok);
    assert.match(result.error, /invalid JSON/);
  });

  it("rejects non-object top-level values", () => {
    for (const raw of ['["a"]', '"x"', "3"]) {
      const result = parseCostOverrides(raw);
      assert.ok(!result.ok, raw);
      assert.match(result.error, /top-level/);
    }
  });

  it("rejects entries that are not objects", () => {
    const result = parseCostOverrides('{"a":1}');
    assert.ok(!result.ok);
    assert.match(result.error, /"a"/);
  });

  it("rejects entries missing numeric input/output", () => {
    const result = parseCostOverrides('{"a":{"input":1}}');
    assert.ok(!result.ok);
    assert.match(result.error, /"input" and "output"/);
  });

  it("rejects non-numeric cacheRead/cacheWrite", () => {
    const result = parseCostOverrides('{"a":{"input":1,"output":2,"cacheRead":"cheap"}}');
    assert.ok(!result.ok);
    assert.match(result.error, /cacheRead/);
  });

  it("fails the whole parse on one bad entry (all-or-nothing, no half-applied costs)", () => {
    const result = parseCostOverrides('{"a":{"input":1,"output":2},"b":{}}');
    assert.ok(!result.ok);
  });
});

describe("DEFAULT_DEEPSEEK_COST", () => {
  it("carries the DeepSeek-flash rates used as the fallback estimate", () => {
    assert.deepEqual(DEFAULT_DEEPSEEK_COST, {
      input: 0.14,
      output: 0.28,
      cacheRead: 0.0028,
      cacheWrite: 0,
    });
  });
});
