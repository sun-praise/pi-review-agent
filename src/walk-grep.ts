/**
 * Default file walker backing the grep tool: regex or literal substring search
 * across text files under cwd, filtered by an optional glob.
 */
import { readFile, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
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

export async function walkGrep(
  cwd: string,
  pattern: string,
  glob: string | undefined,
  cap: number,
  literal?: boolean,
): Promise<string> {
  if (!pattern) return "";
  const out: string[] = [];
  const matcher = glob ? compileGlob(glob) : null;
  let match: (line: string) => boolean;
  if (literal) {
    match = (line) => line.includes(pattern);
  } else {
    const re = safeRegex(pattern);
    if (!re) return ""; // invalid regex → no matches
    match = (line) => re.test(line);
  }

  async function visit(dir: string): Promise<void> {
    if (out.length >= cap) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (out.length >= cap) return;
      if (ent.isDirectory()) {
        if (ent.name in IGNORE) continue;
        await visit(path.join(dir, ent.name));
        continue;
      }
      if (!ent.isFile()) continue;
      // Normalize to forward slashes: globs use `/` as the separator on every
      // platform, but `path.relative` yields `\` on Windows.
      const rel = path.relative(cwd, path.join(dir, ent.name)).split(path.sep).join("/");
      if (matcher && !matcher(rel)) continue;
      try {
        const text = await readFile(path.join(dir, ent.name), "utf8");
        const lines = text.split("\n");
        for (let i = 0; i < lines.length && out.length < cap; i++) {
          if (match(lines[i])) {
            out.push(`${rel}:${i + 1}:${lines[i].slice(0, 200)}`);
          }
        }
      } catch {
        // binary or unreadable: skip.
      }
    }
  }

  await visit(cwd);
  return out.slice(0, cap).join("\n");
}

/** Minimal glob: '*' = any-non-separator, '**' = any including separators. */
function compileGlob(glob: string): (p: string) => boolean {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  try {
    const full = new RegExp(`^${re}$`);
    return (p) => full.test(p);
  } catch {
    return () => false;
  }
}

/** Compile a regex pattern, returning null if invalid. */
function safeRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}
