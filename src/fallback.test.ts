import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseFallbackModels } from "./fallback.js";

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
