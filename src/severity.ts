/**
 * Severity parsing + fail-on-severity gate.
 *
 * The coordinator (or a single reviewer) emits a decision line plus
 * structured sections named in the output-format prompts: 'Blocking
 * Issues', 'Warnings', 'Suggestions'. The prompts ask for the section
 * NAMES only, so every heading shape the models actually emit must parse:
 * bare (`Warnings`), bold (`**Blocking Issues**`), with a colon (the
 * persona prompt's `'Blocking Issues: None'` single-line form), and the
 * habitual markdown `### Warnings` — each with or without the emoji
 * prefix. A whole-line anchor keeps prose ("Warnings are listed below.")
 * from matching.
 *
 * Fail-closed contract (mirrors opencode-actions #280): when the gate is
 * armed and we cannot trust a clean verdict — coordinator produced no
 * recognizable sections, or a reviewer failed to produce content — we
 * fail. A missing reviewer is missing evidence, not a clean bill of health.
 * Recognizing the prompt-literal bare forms necessarily loosens this net:
 * a stray whole-line keyword in otherwise-structureless output now reads
 * as structure. That trade is deliberate — the prompt's own format must
 * not be a red — and prose lines stay non-headings via the whole-line
 * anchor.
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
 * One source pattern for a severity section heading line (see module doc):
 * optional `#`-depth markdown prefix, optional emoji, optional `**` bolding
 * (either side of the emoji — models emit both orders), the keyword, an
 * optional colon, an inline `None`/`无`, and the legacy ` / bilingual
 * suffix`. Capturing group 1 = the heading keyword.
 *
 * SECTION_RE and NEXT_HEADING_RE are BOTH derived from it. The invariant
 * "every line the parser can recognize as a section heading must also
 * terminate the previous section's body" must hold by construction: the
 * two regexes were once hand-written separately and drifted (case flag,
 * emoji/bold order, `X: None` forms) — a heading NEXT_HEADING_RE failed to
 * match let the previous bucket absorb the next section's items and
 * double-count them into the gate (#86 dogfood blocking finding).
 */
const HEADING_LINE =
  "(?:#+\\s*)?(?:🔴|🟡|🟢)?\\s*(?:\\*\\*)?\\s*(?:🔴|🟡|🟢)?\\s*" +
  "(阻塞项|Blocking Issues?|警告项|Warnings?|建议项|Suggestions?)" +
  "(?:\\s*\\*\\*)?(?:\\s*[:：]\\s*(?:\\*\\*)?)?(?:\\s*(?:none|无))?(?:\\s*\\/[^\\n]*)?\\s*$";

const SECTION_RE = new RegExp(`^${HEADING_LINE}`, "gim");

/** A line that ENDS a section body: a severity heading (HEADING_LINE, any
 *  `#`-depth — same source, same case-insensitivity, so a bare `warnings`
 *  cannot leak its items into the previous bucket), or a NON-keyword
 *  markdown heading at `###` depth (the pre-existing rule). Deliberately
 *  NOT any `##`/`#` line: models use depth-2 sub-headings (`## Issue 1:
 *  SQL injection`) to GROUP items inside one section — truncating there
 *  silently dropped the grouped items and let CANNOT MERGE + real blockers
 *  exit green (#86 dogfood, second round). A `#86` issue reference at line
 *  start must not terminate a body either. */
const NEXT_HEADING_RE = new RegExp(`^(?:###\\s|${HEADING_LINE})`, "im");

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

/** Extract the decision. Precedence mirrors resolveVerdict (orchestrate.ts):
 *  the machine-authored `<verdict>` tag is AUTHORITATIVE (the coordinator
 *  prompt says so — the prose first line is for humans), then the first
 *  non-empty line. Without the tag leg, a coordinator opening with prose
 *  yielded UNKNOWN → fail-closed red while the lenient verdict path posted
 *  ✅ — the same mismatched-parser symptom as the heading fix (#86 dogfood).
 *  Deliberately NO scan-the-whole-text fallback here: for the exit gate,
 *  a quoted keyword is not a verdict. */
function extractDecision(text: string): SeverityDecision {
  const tag = text.match(/<verdict>\s*(CAN MERGE|CONDITIONAL MERGE|CANNOT MERGE)\s*<\/verdict>/i);
  const tagged = tag?.[1]?.toUpperCase();
  if (tagged === "CANNOT MERGE" || tagged === "CONDITIONAL MERGE" || tagged === "CAN MERGE") {
    return tagged;
  }
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
  let match: RegExpExecArray | null;
  // Reset lastIndex — the /g flag on a module-level RegExp is stateful.
  SECTION_RE.lastIndex = 0;
  while ((match = SECTION_RE.exec(text)) !== null) {
    foundAny = true;
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
