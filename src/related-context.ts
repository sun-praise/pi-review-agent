/**
 * Related-context: proactively push "files related to the PR's changes" into the
 * reviewer's prompt, so the reviewer sees the blast radius of a change without
 * having to think to grep for it.
 *
 * This is the lightweight ("downgraded") version of #22: no tree-sitter, no
 * symbol table — just a file-level import graph. The bet is that knowing "you
 * changed auth.ts, and api.ts + routes.ts import it" is most of the value of
 * "context > model" without the cost of a multi-language parser.
 *
 * Pipeline: changed files → import graph → reverse edges (who imports each
 * changed file) → symbol summary of the top-N related files → <related_context>
 * block prepended to the reviewer prompt.
 *
 * Reverse edges only (callers of the changed code), not forward edges: forward
 * edges point at files already visible in the diff, so they add little. Reverse
 * edges surface the callers a pull-based reviewer would miss — exactly the
 * "does changing Profile break its callers?" case.
 *
 * Fail-open: any error in graph building or rendering yields "" and the
 * reviewer falls back to diff-only. Mirrors fetchPrContext's best-effort
 * contract — context is an enhancement, never a blocker.
 */
import { readFile, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

/** Directories never walked when building the import graph. Mirrors walk-grep's
 *  IGNORE so the graph reflects source, not generated/vendored code. */
const IGNORE: Record<string, true> = {
  node_modules: true,
  ".git": true,
  dist: true,
  build: true,
  ".next": true,
  ".cache": true,
  coverage: true,
  ".turbo": true,
  vendor: true,
};

/** Source extensions we scan for import statements. TS/JS only — the regexes
 *  are JS-module-shaped; other languages aren't covered by this downgrade. */
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

/**
 * Extract a relative import specifier from a line, or null if the line has no
 * relative import. Matches static `import/export ... from "rel"` and dynamic
 * `import("rel")`. Bare modules (`@scope/pkg`, `node:fs`) are excluded by the
 * leading `./` / `../` / `/` requirement on the captured path.
 *
 * Anchored at line start (after whitespace) so a fixture string like
 * `'import { x } from "./auth"'` embedded in a test array is NOT matched — it
 * doesn't begin with `import`/`export` at the start of a line.
 */
// Match a relative import specifier: ./ , ../ , or a leading /. Built with
// the RegExp constructor (not a regex literal) because the alternation contains
// unescaped / — in a regex literal that slash would be read as the closing
// delimiter and corrupt the rest of the pattern. The constructor sidesteps the
// delimiter problem entirely.
const STATIC_IMPORT = new RegExp(
  "^\\s*(?:import|export)\\b[^;\"'\\n]*?\\bfrom\\s*[\"']((?:\\./|\\.\\./|/)[^\"']+)[\"']",
);
const DYNAMIC_IMPORT = new RegExp(
  "\\bimport\\s*\\(\\s*[\"']((?:\\./|\\.\\./|/)[^\"']+)['\"]\\s*\\)",
);

/**
 * Resolve an import specifier to the repo-relative path of the file it likely
 * refers to, or null if no candidate exists on disk. TypeScript ESM writes
 * `.js` specifiers that resolve to `.ts` files; bare directory specifiers
 * resolve to an `index.*`.
 *
 * Pure given (specifier, importerPath, existsSet): the existsSet is the set of
 * repo-relative file paths the walker discovered, passed in so this stays a
 * pure function over a known file universe (testable without touching disk).
 */
export function resolveSpecifier(
  specifier: string,
  importerPath: string,
  existsSet: Set<string>,
): string | null {
  const dir = path.dirname(importerPath);
  const base = path.posix.normalize(`${dir}/${specifier}`);
  // Candidates in priority order: exact, extension swap (.js→.ts etc.), and
  // index resolution for a directory specifier.
  const candidates: string[] = [base];
  // If the specifier has a known source extension, also try the others
  // (TS writes .js but on disk it's .ts; JS projects might be the reverse).
  const ext = path.extname(base);
  if (ext) {
    const noExt = base.slice(0, -ext.length);
    for (const e of SOURCE_EXTENSIONS) if (e !== ext) candidates.push(noExt + e);
  } else {
    // No extension: could be a file with one of our exts, or a directory.
    for (const e of SOURCE_EXTENSIONS) candidates.push(base + e);
    for (const e of SOURCE_EXTENSIONS) candidates.push(`${base}/index${e}`);
  }
  for (const c of candidates) {
    const norm = path.posix.normalize(c);
    if (existsSet.has(norm)) return norm;
  }
  return null;
}

/**
 * Pull every relative import specifier out of a source file's text. Handles
 * multi-line imports (reads the whole file, not line-by-line) and both static
 * and dynamic forms. Returns specifiers in order of appearance, deduped.
 */
export function extractImports(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const staticMatch = line.match(STATIC_IMPORT);
    if (staticMatch && !seen.has(staticMatch[1])) {
      seen.add(staticMatch[1]);
      out.push(staticMatch[1]);
    }
    const dynMatch = line.match(DYNAMIC_IMPORT);
    if (dynMatch && !seen.has(dynMatch[1])) {
      seen.add(dynMatch[1]);
      out.push(dynMatch[1]);
    }
  }
  return out;
}

/**
 * Walk cwd and build the import graph: file → [files it imports] (repo-relative
 * paths, resolved). Files with no imports are omitted from the map.
 *
 * The walk mirrors walkGrep's skeleton (IGNORE dirs, path.relative, text-only
 * files) but reads whole files and extracts structured import edges rather
 * than matching a pattern line-by-line — so multi-line imports survive.
 */
export async function buildImportGraph(cwd: string): Promise<Map<string, string[]>> {
  const root = path.resolve(cwd);
  const files: string[] = [];
  const graph = new Map<string, string[]>();

  async function visit(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (ent.name in IGNORE) continue;
        await visit(path.join(dir, ent.name));
        continue;
      }
      if (!ent.isFile()) continue;
      const ext = path.extname(ent.name);
      if (!SOURCE_EXTENSIONS.has(ext)) continue;
      files.push(path.relative(root, path.join(dir, ent.name)).split(path.sep).join("/"));
    }
  }

  await visit(root);
  const existsSet = new Set(files);
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(path.join(root, file), "utf8");
    } catch {
      continue;
    }
    const specs = extractImports(text);
    const resolved = specs
      .map((s) => resolveSpecifier(s, file, existsSet))
      .filter((r): r is string => r !== null && r !== file);
    if (resolved.length > 0) graph.set(file, resolved);
  }
  return graph;
}

/**
 * Find files related to the changed files via reverse import edges: who imports
 * a changed file? Returns repo-relative paths, deduped, capped at `limit`.
 *
 * Only reverse edges — callers of changed code. A changed file's own imports
 * (forward edges) are visible in the diff already, so they're excluded.
 */
export function findRelatedFiles(
  changedFiles: string[],
  importGraph: Map<string, string[]>,
  limit: number,
): string[] {
  const changedSet = new Set(changedFiles);
  const related = new Set<string>();
  for (const [importer, imported] of importGraph) {
    if (changedSet.has(importer)) continue; // forward edge from a changed file — skip
    if (imported.some((target) => changedSet.has(target))) {
      related.add(importer);
    }
  }
  return [...related].slice(0, Math.max(0, limit));
}

/** Byte budget for the rendered <related_context> block. Keeps the injected
 *  context bounded; mirrors diffMaxSizeKb's spirit. Generous enough for ~10
 *  file summaries, tight enough to never dominate the prompt. */
const MAX_BYTES = 4096;

/**
 * Render the related files as a <related_context> block: each file's path plus
 * a symbol summary (its export/signature lines, not the whole file). Style
 * mirrors github-context.ts's <pull_request_context> block.
 *
 * Returns "" when there are no related files or when cwd reads fail (fail-open).
 */
export async function renderRelatedContext(
  relatedFiles: string[],
  cwd: string,
  opts?: { maxBytes?: number },
): Promise<string> {
  if (relatedFiles.length === 0) return "";
  const root = path.resolve(cwd);
  const maxBytes = opts?.maxBytes ?? MAX_BYTES;
  const out: string[] = ["<related_context>"];
  out.push(
    "These files import one or more of the changed files (reverse edges). Use",
    "them to judge the blast radius of the change — who calls the code you're",
    "modifying. Do NOT act on this context; it's for grounding your review.",
    "",
  );
  let shown = 0;
  let dropped = 0;
  let bytes = out.join("\n").length;
  for (const file of relatedFiles) {
    const summary = await summarizeFile(root, file).catch(() => null);
    if (!summary) {
      dropped++;
      continue;
    }
    const entry = formatEntry(file, summary);
    if (bytes + entry.length + 1 > maxBytes) {
      dropped += relatedFiles.length - shown;
      break;
    }
    out.push(entry);
    bytes += entry.length + 1;
    shown++;
  }
  if (dropped > 0) {
    out.push(`... (${dropped} more not shown — byte budget)`);
  }
  out.push("</related_context>");
  return out.join("\n");
}

/**
 * A compact symbol summary of a file: the lines that declare what it exports
 * (export/function/class/const at column 0), capped to a handful. This is the
 * "what does this file provide" view, not its full source.
 */
async function summarizeFile(root: string, file: string): Promise<string[] | null> {
  let text: string;
  try {
    text = await readFile(path.join(root, file), "utf8");
  } catch {
    return null;
  }
  const lines = text.split("\n");
  const sigs: string[] = [];
  for (const line of lines) {
    // Top-level declarations only (no leading whitespace): export/function/
    // class/const/type/interface at column 0. Skips indented body lines.
    if (!/^(export\s+)?(async\s+)?(function|class|const|let|type|interface)\b/.test(line)) continue;
    sigs.push(line.trim());
    if (sigs.length >= 12) break;
  }
  return sigs.length > 0 ? sigs : ["(no top-level declarations found)"];
}

function formatEntry(file: string, sigs: string[]): string {
  const indented = sigs.map((s) => `  ${s}`).join("\n");
  return `${file}:\n${indented}`;
}

/**
 * End-to-end: from a diff's changed files + cwd, produce the <related_context>
 * block string (or "" on any failure). This is the single call site for
 * orchestrate/index to use.
 */
export async function buildRelatedContext(
  changedFiles: string[],
  cwd: string,
  opts?: { limit?: number; maxBytes?: number },
): Promise<string> {
  if (changedFiles.length === 0) return "";
  try {
    const graph = await buildImportGraph(cwd);
    const related = findRelatedFiles(changedFiles, graph, opts?.limit ?? 10);
    return renderRelatedContext(related, cwd, { maxBytes: opts?.maxBytes });
  } catch (err: unknown) {
    process.stderr.write(
      `buildRelatedContext: failed (${err instanceof Error ? err.message : String(err)}); skipping related context\n`,
    );
    return "";
  }
}
