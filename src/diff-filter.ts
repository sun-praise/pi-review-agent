/**
 * Strip lock files and auto-generated files from a unified diff so the
 * payload stays inside the model's context window.
 *
 * Ported from opencode-actions/multi-review (Apache-2.0, same author):
 * lock files routinely push diffs past 1MB and trigger "Unexpected server
 * error" across every reviewer at once. This is a defensive, deterministic
 * filter — no regex engine in the search sense, just section splitting and
 * basename matching.
 *
 * Pure: no fs, no env, no side effects. All callers can test it directly.
 */

/** Basename patterns for known lock / auto-generated files. */
const LOCK_PATTERNS: RegExp[] = [
  /\.lockb?$/,
  /^(pnpm-lock|package-lock|yarn|bun)\.(yaml|json|lock|lockb)$/,
  /^(uv|poetry|Gemfile|Cargo|composer)\.lock$/,
  /^go\.sum$/,
  /^(Pipfile|requirements)\.lock$/,
  /^flake\.lock$/,
];

/**
 * Machine-generated build outputs. No review value (a human edit to one is
 * almost always a regenerated artifact) and routinely huge — the
 * `dist/index.cjs` bundle in this repo is ~13 MB and was the #28 413 trigger.
 * Matched against the full b-side path. Disabled only via the explicit
 * `includeBuildArtifacts` opt-in.
 */
const BUILD_ARTIFACT_PATTERNS: RegExp[] = [
  /^(dist|build|out|lib|\.next|\.turbo|coverage)\//,
  /\.(|min)\.(js|cjs|mjs|css)$/,
];

export interface FilterDiffOptions {
  /** Additional glob patterns to exclude, matched against the full file
   *  path in the diff header (e.g. "vendor/**", "*.generated.ts").
   *  Patterns without "/" match basename; patterns with "/" match full path. */
  excludePatterns?: string[];
  /** Maximum diff size in bytes. If the filtered diff exceeds this, whole
   *  leading sections are kept until the budget is exhausted and a truncation
   *  notice is appended. Sections are dropped whole (never sliced mid-hunk):
   *  the same filtered diff feeds parseChangedLines for the verifier rule
   *  layer, which walks hunk ranges and would mis-count lines on a half-hunk. */
  maxSizeBytes?: number;
  /** Keep build artifacts (dist/, build/, *.min.js, …) in the diff instead of
   *  excluding them by default. Opt-in escape hatch; defaults to false since
   *  generated output has no review value and is the usual #28 413 cause. */
  includeBuildArtifacts?: boolean;
}

export interface FilterDiffResult {
  filtered: string;
  removedFiles: string[];
  truncated: boolean;
  filteredBytes: number;
}

interface ExcludeRule {
  regex: RegExp;
  /** true = match against full path; false = basename only. */
  full: boolean;
}

/**
 * Convert a simple glob to a RegExp. Supports `*`, `?`, and `**` (globstar).
 * Globstar semantics: leading `**/` → zero or more leading segments;
 * trailing `/**` → zero or more trailing segments; standalone `**` → `.*`.
 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  const replaced = escaped.replace(
    /\{\{GLOBSTAR\}\}(\/)?|(\/)?\{\{GLOBSTAR\}\}/g,
    (match, trailingSlash, leadingSlash) => {
      if (match.startsWith("{{GLOBSTAR}}") && trailingSlash !== undefined) return "(.+/)?";
      if (leadingSlash !== undefined && match.endsWith("{{GLOBSTAR}}")) return "(/.+)?";
      return ".*";
    },
  );
  return new RegExp("^" + replaced + "$");
}

/** Parse a "diff --git a/<path> b/<path>" header and return the b-side path. */
function parseDiffPath(header: string): string | null {
  const m = header.match(/^diff --git a\/.* b\/(.+?)(?:\s|$)/);
  return m ? m[1] : null;
}

/**
 * Filter lock / auto-generated / user-excluded files from a unified diff.
 *
 * Splits the diff into per-file sections, drops any whose path matches a lock
 * pattern, a build-artifact pattern (dist/, build/, *.min.js, …), or a user
 * exclusion, and optionally truncates to a byte budget (keeping whole leading
 * sections; never slicing a section — see the loop comment for why).
 */
export function filterDiff(diff: string, options?: FilterDiffOptions): FilterDiffResult {
  if (!diff) return { filtered: "", removedFiles: [], truncated: false, filteredBytes: 0 };

  const excludeRules: ExcludeRule[] = (options?.excludePatterns ?? []).map((p) => ({
    regex: globToRegex(p),
    full: p.includes("/"),
  }));
  const excludeBuildArtifacts = !options?.includeBuildArtifacts;
  const maxBytes = options?.maxSizeBytes;

  const sections = diff.split(/(?=^diff --git )/m);
  const kept: string[] = [];
  const removed: string[] = [];

  for (const section of sections) {
    if (!section) continue;
    const newlineIdx = section.indexOf("\n");
    const header = newlineIdx >= 0 ? section.slice(0, newlineIdx) : section;
    const filePath = parseDiffPath(header);
    const slashIdx = filePath ? filePath.lastIndexOf("/") : -1;
    const base = filePath ? (slashIdx >= 0 ? filePath.slice(slashIdx + 1) : filePath) : null;

    const isLock = base !== null && LOCK_PATTERNS.some((re) => re.test(base));
    const isBuildArtifact =
      excludeBuildArtifacts &&
      filePath !== null &&
      BUILD_ARTIFACT_PATTERNS.some((re) => re.test(filePath));
    const isExcluded =
      (base !== null && excludeRules.some((r) => !r.full && r.regex.test(base))) ||
      (filePath !== null && excludeRules.some((r) => r.full && r.regex.test(filePath)));

    if (isLock || isBuildArtifact || isExcluded) {
      removed.push(filePath ?? base ?? "unknown");
    } else {
      kept.push(section);
    }
  }

  let filtered = kept.join("");
  let truncated = false;

  if (maxBytes !== undefined && maxBytes > 0) {
    const totalBytes = Buffer.byteLength(filtered, "utf8");
    if (totalBytes > maxBytes) {
      const truncatedKept: string[] = [];
      let budget = maxBytes;
      for (const section of kept) {
        const size = Buffer.byteLength(section, "utf8");
        // Drop the section whole once it would blow the budget — including the
        // FIRST one. Slicing mid-hunk is not an option: this same filtered diff
        // feeds parseChangedLines (verifier rule layer), which walks @@ ranges
        // and would emit wrong line numbers on a half-hunk. If even the first
        // section exceeds the budget, truncatedKept stays empty and we surface
        // only the notice — preferable to shipping an oversized payload (#28).
        if (size > budget) break;
        truncatedKept.push(section);
        budget -= size;
      }
      const shownCount = truncatedKept.length;
      const totalCount = kept.length;
      const totalKb = Math.round(totalBytes / 1024);
      const notice =
        `\n[Diff truncated: ${shownCount} of ${totalCount} file sections shown — ` +
        `${totalKb} KB total after filtering]\n`;
      filtered = truncatedKept.join("") + notice;
      truncated = true;
    }
  }

  return {
    filtered,
    removedFiles: removed,
    truncated,
    filteredBytes: Buffer.byteLength(filtered, "utf8"),
  };
}
