import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveModelIds } from "./model-ids.js";

describe("resolveModelIds", () => {
  it("keeps every distinct id in first-seen order (primary, roles, fallbacks)", () => {
    assert.deepEqual(
      resolveModelIds(["deepseek-v4-flash", "mimo-v2.5", "deepseek-v4"]),
      ["deepseek-v4-flash", "mimo-v2.5", "deepseek-v4"],
    );
  });

  it("dedupes repeated ids, keeping the first occurrence", () => {
    assert.deepEqual(
      resolveModelIds(["mimo-v2.5", "deepseek-v4-flash", "mimo-v2.5"]),
      ["mimo-v2.5", "deepseek-v4-flash"],
    );
  });

  it("drops empty and undefined entries", () => {
    assert.deepEqual(resolveModelIds(["", undefined, "mimo-v2.5"]), ["mimo-v2.5"]);
  });

  it("defaults to deepseek-v4-flash when nothing remains", () => {
    assert.deepEqual(resolveModelIds([]), ["deepseek-v4-flash"]);
    assert.deepEqual(resolveModelIds(["", undefined]), ["deepseek-v4-flash"]);
  });
});
