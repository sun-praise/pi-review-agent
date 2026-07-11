/**
 * Style-guide loading for review personas.
 *
 * A style-guide is a plain-text/markdown file maintained by the repository
 * owner. When present, it is appended to the system prompt of personas that
 * are configured to receive it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

/** Relative paths checked in order when no explicit path is provided. */
const DEFAULT_STYLE_GUIDE_PATHS = [
  "STYLE_GUIDE.md",
  ".github/STYLE_GUIDE.md",
  "docs/style-guide.md",
  ".github/style-guide.md",
];

/**
 * Load the repository style-guide.
 *
 * @param cwd - Repository root used to resolve default paths.
 * @param explicitPath - Optional override. If given, it is resolved against cwd
 *   and returned when readable; otherwise an error is thrown.
 * @returns The file contents, or undefined when no file is found and no
 *   explicit path was requested.
 */
export function loadStyleGuide(cwd: string, explicitPath?: string): string | undefined {
  if (explicitPath) {
    const full = path.resolve(cwd, explicitPath);
    return readFileSync(full, "utf8");
  }

  for (const relative of DEFAULT_STYLE_GUIDE_PATHS) {
    const full = path.join(cwd, relative);
    try {
      return readFileSync(full, "utf8");
    } catch {
      // Path missing or unreadable; try the next candidate.
    }
  }

  return undefined;
}
