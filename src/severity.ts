/**
 * Severity parsing + fail-on-severity gate.
 *
 * The coordinator (or a single reviewer) emits a decision line plus
 * structured sections: `### Blocking Issues`, `### Warnings`, `### Suggestions`.
 * We parse those into counts and turn them into an exit-code decision.
 *
 * Fail-closed contract (mirrors opencode-actions #280): when the gate is
 * armed and we cannot trust a clean verdict — coordinator produced no
 * recognizable sections, or a reviewer failed to produce content — we
 * fail. A missing reviewer is missing evidence, not a clean bill of health.
 *
 * Pure: no env, no fs. The exit-code wiring lives in index.ts.
 */

export type SeverityDecision = "CAN MERGE" | "CONDITIONAL MERGE" | "CANNOT MERGE" | "UNKNOWN";

export type FailMode = "none" | "blocking" | "warning";

export interface Severity {
  decision: SeverityDecision;
  blockingCount: number;
  warningCount: number;
  /** True when no severity headings were found — output unparseable. */
  fallback: boolean;
}

/**
 * Matches severity section headings in both English (the canonical prompt
 * format) and Chinese (the default output language), with or without the
 * emoji prefix opencode uses. Capturing group 1 = the heading keyword.
 */
const SECTION_RE =
  /^###\s*(?:🔴|🟡|🟢)?\s*(阻塞项|Blocking Issues?|警告项|Warnings?|建议项|Suggestions?)(?:\s+\/.*)?$/gim;

const NEXT_HEADING_RE = /^###\s/m;

/** Map a localized heading keyword to a severity bucket. */
function bucketFor(heading: string): "blocking" | "warning" | "suggestion" | null {
  const lower = heading.toLowerCase();
  if (heading === "阻塞项" || lower.startsWith("blocking")) return "blocking";
  if (heading === "警告项" || lower.startsWith("warning")) return "warning";
  if (heading === "建议项" || lower.startsWith("suggestion")) return "suggestion";
  return null;
}

/** Count meaningful list items under a section body, skipping "None" / "无". */
function countListItems(body: string): number {
  let count = 0;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const m = line.match(/^[-*]\s+(.+)$|^(\d+)\.\s+(.+)$/);
    if (!m) continue;
    const content = (m[1] ?? m[3]).trim().toLowerCase();
    if (content === "无" || content === "none") continue;
    count++;
  }
  return count;
}

/** Extract the decision from the first non-empty line. */
function extractDecision(text: string): SeverityDecision {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const lower = line.toLowerCase();
    if (lower.includes("不可合并") || lower.includes("cannot merge")) return "CANNOT MERGE";
    if (lower.includes("有条件合并") || lower.includes("conditional merge")) return "CONDITIONAL MERGE";
    if (lower.includes("可合并") || lower.includes("can merge")) return "CAN MERGE";
    return "UNKNOWN";
  }
  return "UNKNOWN";
}

export function parseSeverity(text: string): Severity {
  const result: Severity = {
    decision: extractDecision(text),
    blockingCount: 0,
    warningCount: 0,
    fallback: false,
  };

  let foundAny = false;
  let firstHeadingIndex = text.length;
  let match: RegExpExecArray | null;
  // Reset lastIndex — the /g flag on a module-level RegExp is stateful.
  SECTION_RE.lastIndex = 0;
  while ((match = SECTION_RE.exec(text)) !== null) {
    foundAny = true;
    if (match.index < firstHeadingIndex) firstHeadingIndex = match.index;
    const bucket = bucketFor(match[1]);
    if (bucket === "blocking" || bucket === "warning") {
      const bodyStart = match.index + match[0].length;
      const rest = text.slice(bodyStart);
      const nextMatch = rest.search(NEXT_HEADING_RE);
      const body = nextMatch === -1 ? rest : rest.slice(0, nextMatch);
      const count = countListItems(body);
      if (bucket === "blocking") result.blockingCount += count;
      else result.warningCount += count;
    }
  }
  if (!foundAny) result.fallback = true;
  return result;
}

/**
 * Decide whether the severity gate should fail the run.
 *
 * Fail-closed: when the gate is armed (mode ≠ none) and the output is
 * unparseable (fallback) or the decision is UNKNOWN, we cannot trust a
 * clean verdict — fail. This is the hard guarantee that an incomplete or
 * garbled review never looks like a pass.
 */
export function shouldFail(severity: Severity, mode: FailMode): boolean {
  if (mode === "none") return false;
  if (severity.fallback || severity.decision === "UNKNOWN") return true;
  if (mode === "blocking") return severity.blockingCount > 0;
  return severity.blockingCount > 0 || severity.warningCount > 0;
}

/**
 * Force a CANNOT-MERGE severity when reviewers failed to produce content.
 * Mutates a copy; pure with respect to the input. Use this to surface
 * missing reviewers as blocking evidence before the gate runs.
 */
export function withFailedReviewerOverride(
  severity: Severity,
  failedReviewerNames: string[],
): Severity {
  if (failedReviewerNames.length === 0) return severity;
  return {
    decision: "CANNOT MERGE",
    blockingCount: Math.max(1, severity.blockingCount),
    warningCount: severity.warningCount,
    // We have a concrete blocking entry now; no longer "unparseable".
    fallback: false,
  };
}
