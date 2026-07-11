import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { loadPersonas, BUILT_IN_PERSONAS } from "./personas.js";

describe("loadPersonas", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "personas-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns built-in personas when .github/reviewers is absent", () => {
    const personas = loadPersonas(tmpDir);
    assert.equal(personas.length, BUILT_IN_PERSONAS.length);
    assert.ok(personas.some((p) => p.name === "quality" && p.useStyleGuide));
    assert.ok(personas.some((p) => p.name === "style" && p.useStyleGuide));
    assert.ok(personas.some((p) => p.name === "security" && !p.useStyleGuide));
  });

  it("parses use-style-guide from custom persona files", () => {
    const reviewers = path.join(tmpDir, ".github", "reviewers");
    mkdirSync(reviewers, { recursive: true });
    writeFileSync(
      path.join(reviewers, "custom.yaml"),
      ["name: custom", "prompt: Custom reviewer.", "use-style-guide: true"].join("\n"),
    );
    const personas = loadPersonas(tmpDir);
    const custom = personas.find((p) => p.name === "custom");
    assert.ok(custom);
    assert.equal(custom?.useStyleGuide, true);
  });

  it("defaults custom personas to no style-guide", () => {
    const reviewers = path.join(tmpDir, ".github", "reviewers");
    mkdirSync(reviewers, { recursive: true });
    writeFileSync(
      path.join(reviewers, "custom.yaml"),
      ["name: custom", "prompt: Custom reviewer."].join("\n"),
    );
    const personas = loadPersonas(tmpDir);
    const custom = personas.find((p) => p.name === "custom");
    assert.equal(custom?.useStyleGuide, undefined);
  });

  it("rejects invalid use-style-guide values", () => {
    const reviewers = path.join(tmpDir, ".github", "reviewers");
    mkdirSync(reviewers, { recursive: true });
    writeFileSync(
      path.join(reviewers, "bad.yaml"),
      ["name: bad", "prompt: Bad.", "use-style-guide: maybe"].join("\n"),
    );
    assert.throws(() => loadPersonas(tmpDir), /use-style-guide/);
  });

  it("overrides built-in quality while preserving useStyleGuide", () => {
    const reviewers = path.join(tmpDir, ".github", "reviewers");
    mkdirSync(reviewers, { recursive: true });
    writeFileSync(
      path.join(reviewers, "quality.yaml"),
      ["name: quality", "prompt: Overridden quality.", "use-style-guide: false"].join("\n"),
    );
    const personas = loadPersonas(tmpDir);
    const quality = personas.find((p) => p.name === "quality");
    assert.equal(quality?.prompt, "Overridden quality.");
    assert.equal(quality?.useStyleGuide, false);
  });
});
