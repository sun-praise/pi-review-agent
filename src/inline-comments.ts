/**
 * Structured inline-comment extraction from coordinator output.
 *
 * Design contract:
 *   The coordinator writes its usual markdown verdict report, then optionally
 *   appends an `<inline_comments>` block carrying a JSON array of findings
 *   pinned to specific diff lines. We parse that block into typed objects the
 *   PR-comment layer can hand to the GitHub Reviews API.
 *
 *   The block is OPTIONAL and best-effort: missing block, malformed JSON, or
 *   individually invalid entries never fail the review — we just return []
 *   (or the subset of valid entries) and the comment layer falls back to a
 *   plain summary comment. This keeps the structured layer strictly additive
 *   on top of the existing markdown/verdict/severity contract.
 *
 * Severity vocabulary mirrors our SeverityDecision buckets (blocking /
 * warning / suggestion), NOT pi-reviewer's CRITICAL/WARN/INFO — we group by
 * merge impact, not display color. We accept a few common aliases so the
 * model isn't punished for paraphrasing.
 */

/** Severity bucket aligned with the verdict gate (severity.ts). */
export type InlineSeverity = "blocking" | "warning" | "suggestion";

/** A single inline comment pinned to a diff line. */
export interface InlineComment {
  /** Repository-relative file path, e.g. "src/auth.ts". */
  file: string;
  /** 1-based line number in the file (not the diff position). */
  line: number;
  /** RIGHT = added/context line, LEFT = removed line (GitHub Reviews API). */
  side: "LEFT" | "RIGHT";
  severity: InlineSeverity;
  /** Markdown body. We prefix the severity emoji at render time, not here. */
  body: string;
}

const SEVERITY_ALIAS: Record<string, InlineSeverity> = {
  blocking: "blocking",
  blocker: "blocking",
  block: "blocking",
  critical: "blocking",
  error: "blocking",
  warning: "warning",
  warn: "warning",
  suggestion: "suggestion",
  info: "suggestion",
  minor: "suggestion",
  nit: "suggestion",
};

function normalizeSeverity(value: unknown): InlineSeverity | undefined {
  if (typeof value !== "string") return undefined;
  return SEVERITY_ALIAS[value.trim().toLowerCase()] ?? undefined;
}

/**
 * isInlineComment — runtime guard. Rejects anything missing a required field
 * or carrying a non-sensical value (non-finite line, empty body, unknown side).
 * Used instead of inline cast access per the project lint rule.
 */
function isInlineComment(value: unknown): value is InlineComment {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.file === "string" && v.file.length > 0 &&
    typeof v.line === "number" && Number.isFinite(v.line) && v.line >= 1 &&
    (v.side === "LEFT" || v.side === "RIGHT") &&
    typeof v.body === "string" && v.body.trim().length > 0 &&
    normalizeSeverity(v.severity) !== undefined
  );
}

/**
 * Extract the first balanced `[...]` span from `text`, string- and
 * escape-aware. Returns the raw substring (including brackets) or null when
 * no balanced array literal is found. We scan for arrays (not objects)
 * because the inline_comments block is defined as a JSON array of comments;
 * a stray inline object earlier in the buffer must not match.
 */
function extractFirstJsonArray(text: string): string | null {
  const start = text.indexOf("[");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (escape) { escape = false; continue; }
    if (c === "\\" && inString) { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === "[") depth += 1;
    else if (c === "]") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function tryParseArray(raw: string): unknown[] | null {
  // Tolerate raw control chars inside string values (rare model artifact).
  for (const candidate of [
    raw,
    raw.replace(/[\u0000-\u001F]/g, (c) => {
      if (c === "\n") return "\\n";
      if (c === "\r") return "\\r";
      if (c === "\t") return "\\t";
      return "";
    }),
  ]) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // try next candidate
    }
  }
  return null;
}

/**
 * Pull the `<inline_comments>` block out of the coordinator text. Returns the
 * inner payload (which may include a ```json fence) or null when absent.
 */
function extractBlock(text: string): string | null {
  const open = text.indexOf("<inline_comments>");
  if (open === -1) return null;
  const close = text.indexOf("</inline_comments>", open);
  if (close === -1) return null; // unclosed — treat as absent, don't guess
  return text.slice(open + "<inline_comments>".length, close);
}

/**
 * Parse structured inline comments from coordinator markdown.
 *
 * Returns the validated subset (possibly empty). Never throws: a missing or
 * malformed block degrades to [] so callers can branch on length alone.
 *
 * Order of fallback attempts on the inner payload:
 *   1. raw payload (may be a fenced ```json array)
 *   2. payload with a leading ```json / ``` fence stripped
 *   3. first balanced `[...]` anywhere in the payload
 */
export function parseInlineComments(text: string): InlineComment[] {
  const payload = extractBlock(text);
  if (payload === null) return [];
  if (payload.trim().length === 0) return [];

  const candidates: string[] = [payload];

  // Strip a wrapping ```json ... ``` or ``` ... ``` fence.
  const fence = payload.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) candidates.push(fence[1]);

  // Brace-balanced extraction as a last resort (handles trailing prose).
  const balanced = extractFirstJsonArray(payload);
  if (balanced) candidates.push(balanced);

  for (const candidate of candidates) {
    const arr = tryParseArray(candidate);
    if (arr === null) continue;
    const comments: InlineComment[] = [];
    for (const entry of arr) {
      if (!isInlineComment(entry)) continue;
      comments.push({
        file: entry.file,
        line: entry.line,
        side: entry.side,
        severity: normalizeSeverity(entry.severity) as InlineSeverity,
        body: entry.body,
      });
    }
    if (comments.length > 0) return comments;
    // Parsed a valid array but zero valid entries — stop, don't keep trying.
    return [];
  }
  return [];
}
