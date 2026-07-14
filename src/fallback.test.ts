import { describe, it } from "node:test";
import assert from "node:assert/strict";

/** Copy of parseFallbackModels from index.ts for pure unit testing. */
function parseFallbackModels(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

describe("parseFallbackModels", () => {
  it("returns empty array for undefined", () => {
    assert.deepEqual(parseFallbackModels(undefined), []);
  });

  it("returns empty array for empty string", () => {
    assert.deepEqual(parseFallbackModels(""), []);
  });

  it("parses single model", () => {
    assert.deepEqual(parseFallbackModels("mimo-v2.5"), ["mimo-v2.5"]);
  });

  it("parses multiple comma-separated models", () => {
    assert.deepEqual(parseFallbackModels("gpt-4o, mimo-v2.5"), ["gpt-4o", "mimo-v2.5"]);
  });

  it("trims whitespace", () => {
    assert.deepEqual(parseFallbackModels(" gpt-4o , mimo-v2.5 "), ["gpt-4o", "mimo-v2.5"]);
  });

  it("filters empty segments", () => {
    assert.deepEqual(parseFallbackModels("gpt-4o,,mimo-v2.5"), ["gpt-4o", "mimo-v2.5"]);
  });
});
