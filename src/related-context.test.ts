import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  extractImports,
  resolveSpecifier,
  buildImportGraph,
  findRelatedFiles,
  renderRelatedContext,
  buildRelatedContext,
} from "./related-context.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "related-ctx-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("extractImports", () => {
  it("extracts static named imports with .js specifier", () => {
    const specs = extractImports('import { foo } from "./foo.js";');
    assert.deepEqual(specs, ["./foo.js"]);
  });

  it("extracts mixed value + inline-type imports", () => {
    const specs = extractImports('import { runReview, type ReviewResult } from "./review.js";');
    assert.deepEqual(specs, ["./review.js"]);
  });

  it("extracts dynamic import()", () => {
    const specs = extractImports('const x = await import("./verifier-agent.js");');
    assert.deepEqual(specs, ["./verifier-agent.js"]);
  });

  it("extracts re-export from", () => {
    const specs = extractImports('export { renderTeamComment } from "./team-comment.js";');
    assert.deepEqual(specs, ["./team-comment.js"]);
  });

  it("extracts parent-relative imports (../)", () => {
    const specs = extractImports('import type { Foo } from "../types.js";');
    assert.deepEqual(specs, ["../types.js"]);
  });

  it("excludes bare module specifiers (@scope/pkg, node:fs)", () => {
    const specs = extractImports([
      'import { x } from "@earendil-works/pi-ai";',
      'import { readFile } from "node:fs/promises";',
      'import { local } from "./local.js";',
    ].join("\n"));
    assert.deepEqual(specs, ["./local.js"]);
  });

  it("does not match import text embedded in a string literal", () => {
    // The walk-grep.test.ts fixture trap: a string starting with the import text
    // but not at the start of a line. Our regex anchors at ^\s*.
    const fixture = [
      "const cases = [",
      '  \'import { validateToken } from "./auth";\',',
      "];",
    ].join("\n");
    assert.deepEqual(extractImports(fixture), []);
  });

  it("dedupes repeated specifiers", () => {
    const specs = extractImports([
      'import { a } from "./foo.js";',
      'import { b } from "./foo.js";',
    ].join("\n"));
    assert.deepEqual(specs, ["./foo.js"]);
  });
});

describe("resolveSpecifier", () => {
  const exists = new Set(["src/foo.ts", "src/bar.ts", "src/util/index.ts", "src/baz.js"]);

  it("resolves .js specifier to .ts file on disk", () => {
    assert.equal(resolveSpecifier("./foo.js", "src/x.ts", exists), "src/foo.ts");
  });

  it("resolves a parent-relative specifier", () => {
    assert.equal(resolveSpecifier("../foo.js", "src/sub/x.ts", exists), "src/foo.ts");
  });

  it("resolves a directory specifier to index.ts", () => {
    assert.equal(resolveSpecifier("./util", "src/x.ts", exists), "src/util/index.ts");
  });

  it("resolves an exact .js match when no .ts exists", () => {
    assert.equal(resolveSpecifier("./baz.js", "src/x.ts", exists), "src/baz.js");
  });

  it("returns null for a specifier that resolves to no file", () => {
    assert.equal(resolveSpecifier("./nope.js", "src/x.ts", exists), null);
  });

  it("returns null for a bare module specifier", () => {
    assert.equal(resolveSpecifier("@scope/pkg", "src/x.ts", exists), null);
  });
});

describe("buildImportGraph", () => {
  it("builds a graph of resolved import edges across the repo", async () => {
    // src/auth.ts  <- imported by api.ts and routes.ts
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "auth.ts"), 'export function validate() {}\n', "utf8");
    await writeFile(
      path.join(dir, "src", "api.ts"),
      'import { validate } from "./auth.js";\nexport function handler() { validate(); }\n',
      "utf8",
    );
    await writeFile(
      path.join(dir, "src", "routes.ts"),
      'import { validate } from "./auth.js";\n',
      "utf8",
    );
    // unrelated.ts imports nothing relevant
    await writeFile(path.join(dir, "src", "unrelated.ts"), 'export const x = 1;\n', "utf8");

    const graph = await buildImportGraph(dir);
    const apiDir = path.join(dir, "src");
    const rel = (f: string) => path.relative(dir, path.join(apiDir, f)).split(path.sep).join("/");
    assert.deepEqual(graph.get(rel("api.ts")), [rel("auth.ts")]);
    assert.deepEqual(graph.get(rel("routes.ts")), [rel("auth.ts")]);
    assert.ok(!graph.has(rel("unrelated.ts")), "files with no imports are omitted");
    assert.ok(!graph.has(rel("auth.ts")), "auth.ts has no imports → omitted");
  });

  it("skips ignored directories (node_modules, dist)", async () => {
    await mkdir(path.join(dir, "src"), { recursive: true });
    await mkdir(path.join(dir, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(dir, "src", "app.ts"), 'import { x } from "./dep.js";\n', "utf8");
    await writeFile(path.join(dir, "node_modules", "pkg", "dep.ts"), 'export const x = 1;\n', "utf8");

    const graph = await buildImportGraph(dir);
    // node_modules is never walked, so dep.ts isn't in existsSet → app.ts's
    // only import resolves to nothing → the edge is dropped and app.ts (now
    // having no resolved imports) is omitted from the graph entirely.
    const app = path.join("src", "app.ts");
    assert.ok(!graph.has(app), "app.ts has only an unresolvable import → omitted");
    assert.ok(!graph.has(path.join("node_modules", "pkg", "dep.ts")), "node_modules never walked");
  });
});

describe("findRelatedFiles", () => {
  it("returns reverse edges: who imports a changed file", () => {
    const graph = new Map<string, string[]>([
      ["src/api.ts", ["src/auth.ts"]],
      ["src/routes.ts", ["src/auth.ts"]],
      ["src/auth.ts", ["src/util.ts"]],
      ["src/unrelated.ts", ["src/other.ts"]],
    ]);
    const related = findRelatedFiles(["src/auth.ts"], graph, 10);
    assert.deepEqual(related.sort(), ["src/api.ts", "src/routes.ts"]);
  });

  it("excludes forward edges from a changed file", () => {
    // auth.ts is changed AND imports util.ts — util.ts is a forward edge, not a
    // reverse one, so it must not appear even though auth.ts imports it.
    const graph = new Map<string, string[]>([
      ["src/auth.ts", ["src/util.ts"]],
    ]);
    const related = findRelatedFiles(["src/auth.ts"], graph, 10);
    assert.deepEqual(related, []);
  });

  it("respects the limit cap", () => {
    const graph = new Map<string, string[]>([
      ["src/a.ts", ["src/auth.ts"]],
      ["src/b.ts", ["src/auth.ts"]],
      ["src/c.ts", ["src/auth.ts"]],
    ]);
    const related = findRelatedFiles(["src/auth.ts"], graph, 2);
    assert.equal(related.length, 2);
  });

  it("returns empty for a changed file nobody imports", () => {
    const graph = new Map<string, string[]>([["src/x.ts", ["src/y.ts"]]]);
    assert.deepEqual(findRelatedFiles(["src/orphan.ts"], graph, 10), []);
  });
});

describe("renderRelatedContext", () => {
  it("returns empty string for no related files", async () => {
    assert.equal(await renderRelatedContext([], dir), "");
  });

  it("renders a <related_context> block with file symbol summaries", async () => {
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(
      path.join(dir, "src", "api.ts"),
      'import { validate } from "./auth.js";\nexport function handler() {}\nexport const VERSION = 1;\n',
      "utf8",
    );
    const block = await renderRelatedContext(["src/api.ts"], dir);
    assert.ok(block.startsWith("<related_context>"));
    assert.ok(block.endsWith("</related_context>"));
    assert.ok(block.includes("src/api.ts:"));
    assert.ok(block.includes("export function handler() {}"));
    assert.ok(block.includes("export const VERSION = 1;"));
  });

  it("respects the byte budget and notes truncation", async () => {
    await mkdir(path.join(dir, "src"), { recursive: true });
    const files: string[] = [];
    for (let i = 0; i < 5; i++) {
      const name = `f${i}.ts`;
      await writeFile(
        path.join(dir, "src", name),
        `export function fn${i}() {}\nexport const c${i} = ${i};\n`,
        "utf8",
      );
      files.push(`src/${name}`);
    }
    // Tiny budget forces truncation after ~1 file.
    const block = await renderRelatedContext(files, dir, { maxBytes: 200 });
    assert.ok(block.includes("more not shown"), "should note truncation");
  });
});

describe("buildRelatedContext (end-to-end)", () => {
  it("returns '' when no changed files", async () => {
    assert.equal(await buildRelatedContext([], dir), "");
  });

  it("returns '' (not a throw) when cwd does not exist", async () => {
    const result = await buildRelatedContext(["src/x.ts"], path.join(dir, "does-not-exist"));
    assert.equal(result, "");
  });

  it("builds a related-context block for a real import graph", async () => {
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "auth.ts"), 'export function validate() {}\n', "utf8");
    await writeFile(
      path.join(dir, "src", "api.ts"),
      'import { validate } from "./auth.js";\nexport function handler() {}\n',
      "utf8",
    );
    const block = await buildRelatedContext(["src/auth.ts"], dir);
    assert.ok(block.includes("<related_context>"));
    assert.ok(block.includes("src/api.ts"), "should surface the caller of auth.ts");
  });
});
