import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { loadStyleGuide } from "./style-guide.js";

describe("loadStyleGuide", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "style-guide-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns undefined when no style-guide exists", () => {
    assert.equal(loadStyleGuide(tmpDir), undefined);
  });

  it("detects STYLE_GUIDE.md in the repository root", () => {
    writeFileSync(path.join(tmpDir, "STYLE_GUIDE.md"), "root guide");
    assert.equal(loadStyleGuide(tmpDir), "root guide");
  });

  it("detects .github/STYLE_GUIDE.md", () => {
    mkdirSync(path.join(tmpDir, ".github"));
    writeFileSync(path.join(tmpDir, ".github", "STYLE_GUIDE.md"), "github guide");
    assert.equal(loadStyleGuide(tmpDir), "github guide");
  });

  it("detects docs/style-guide.md", () => {
    mkdirSync(path.join(tmpDir, "docs"));
    writeFileSync(path.join(tmpDir, "docs", "style-guide.md"), "docs guide");
    assert.equal(loadStyleGuide(tmpDir), "docs guide");
  });

  it("prefers the root file over .github and docs", () => {
    mkdirSync(path.join(tmpDir, ".github"));
    mkdirSync(path.join(tmpDir, "docs"));
    writeFileSync(path.join(tmpDir, "STYLE_GUIDE.md"), "root guide");
    writeFileSync(path.join(tmpDir, ".github", "STYLE_GUIDE.md"), "github guide");
    writeFileSync(path.join(tmpDir, "docs", "style-guide.md"), "docs guide");
    assert.equal(loadStyleGuide(tmpDir), "root guide");
  });

  it("uses an explicit path when provided", () => {
    writeFileSync(path.join(tmpDir, "custom.md"), "custom guide");
    assert.equal(loadStyleGuide(tmpDir, "custom.md"), "custom guide");
  });

  it("throws when the explicit path does not exist", () => {
    assert.throws(() => loadStyleGuide(tmpDir, "missing.md"), /ENOENT/);
  });

  it("resolves explicit relative paths against cwd", () => {
    mkdirSync(path.join(tmpDir, "docs"));
    writeFileSync(path.join(tmpDir, "docs", "custom.md"), "nested guide");
    assert.equal(loadStyleGuide(tmpDir, "docs/custom.md"), "nested guide");
  });
});
