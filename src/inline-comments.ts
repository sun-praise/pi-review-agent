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
 * Validate + normalize a raw entry into an InlineComment in one pass, so
 * severity normalization happens exactly once per entry (the previous
 * type-guard form looked it up twice — once to validate, once to build).
 * Returns null for any invalid shape; callers just filter.
 */
function toInlineComment(value: unknown): InlineComment | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.file !== "string" || v.file.length === 0) return null;
  if (typeof v.line !== "number" || !Number.isFinite(v.line) || v.line < 1) return null;
  if (v.side !== "LEFT" && v.side !== "RIGHT") return null;
  if (typeof v.body !== "string" || v.body.trim().length === 0) return null;
  const severity = normalizeSeverity(v.severity);
  if (severity === undefined) return null;
  return { file: v.file, line: v.line, side: v.side, severity, body: v.body };
}

/**
 * Extract the first balanced `[...]` span from `text`, string- and
 * escape-aware. Returns the raw substring (including brackets) or null when
 * no balanced array literal is found. We scan for arrays (not objects)
 * because the inline_comments block is defined as a JSON array of comments;
 * a stray inline object earlier in the buffer must not match.
 *
 * Boundary: scanning starts at the first literal `[`, so a `[` appearing
 * inside a string value earlier in the buffer (unescaped, which is already
 * invalid JSON) could anchor the scan at the wrong offset. This is covered
 * by the multi-candidate fallback in parseInlineComments (raw payload and
 * fence-stripped payload are tried first, before this balanced extractor).
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
  // Happy path: try as-is. Avoids allocating a cleaned copy when the model
  // emitted valid JSON (the common case).
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // fall through to control-char cleanup
  }
  // Sad path: model emitted raw control chars inside string values, which
  // are illegal in JSON. Replace ALL control chars (0x00-0x1F) with a space
  // — never with an escape sequence. Replacing structural whitespace (like
  // a real newline outside a string) with "\\n" would corrupt it into an
  // invalid token; space keeps both structural and in-string cases valid.
  try {
    const cleaned = raw.replace(/[\u0000-\u001F]/g, " ");
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // give up — caller will try the next candidate
  }
  return null;
}

/**
 * Split the body of a JSON array (the text between `[` and `]`) into
 * individual `{...}` object substrings, brace-balanced and string-aware.
 *
 * Used by the lenient fallback when the whole array won't parse: a single
 * malformed entry (e.g. the coordinator using unescaped `"` inside a body
 * string for Chinese-style quotes `"..."`) shouldn't sink the other valid
 * entries in the same block.
 */
function splitEntries(arrayBody: string): string[] {
  const entries: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let escape = false;
  for (let i = 0; i < arrayBody.length; i += 1) {
    const c = arrayBody[i];
    if (escape) { escape = false; continue; }
    if (c === "\\" && inStr) { escape = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (c === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        entries.push(arrayBody.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return entries;
}

/**
 * Lenient fallback: parse each `{...}` entry independently, skip the ones
 * that fail. Returns the validated comments (possibly empty). Used only when
 * the whole array fails to parse — drops bad entries instead of dropping
 * the entire block.
 *
 * Also tolerates raw control chars inside string values (same cleanup as
 * tryParseArray) on a per-entry basis.
 */
function parseEntriesLenient(candidate: string): InlineComment[] {
  const lb = candidate.indexOf("[");
  const rb = candidate.lastIndexOf("]");
  if (lb === -1 || rb === -1 || rb <= lb) return [];
  const body = candidate.slice(lb + 1, rb);
  const comments: InlineComment[] = [];
  for (const entrySrc of splitEntries(body)) {
    let parsed: unknown = undefined;
    try {
      parsed = JSON.parse(entrySrc);
    } catch {
      try {
        parsed = JSON.parse(entrySrc.replace(/[\u0000-\u001F]/g, " "));
      } catch {
        continue; // one bad entry doesn't sink the rest
      }
    }
    const c = toInlineComment(parsed);
    if (c !== null) comments.push(c);
  }
  return comments;
}

/**
 * Find every `<inline_comments>...</inline_comments>` candidate payload in the
 * coordinator text, in order of appearance.
 *
 * Why plural, not first-match: the coordinator routinely discusses its own
 * output format in the surrounding prose (e.g. `coordinator.content.includes
 * ("<inline_comments>")`), and a JSON body string value can also contain the
 * literal tag name. Those textual mentions pair with a later closing tag and
 * form "fake" candidate blocks ahead of the real one. Collecting every
 * candidate and letting the parser try each is what makes self-referential
 * coordinator output survivable: prose candidates fail JSON parsing and are
 * skipped; the real block (a fenced JSON array) parses and wins.
 *
 * An unclosed `<inline_comments>` (no matching close) stops the scan — we
 * don't guess where it ends.
 */
export function extractAllBlocks(text: string): string[] {
  const OPEN = "<inline_comments>";
  const CLOSE = "</inline_comments>";
  const payloads: string[] = [];
  let idx = 0;
  while (idx <= text.length - OPEN.length) {
    const open = text.indexOf(OPEN, idx);
    if (open === -1) break;
    const close = text.indexOf(CLOSE, open + OPEN.length);
    if (close === -1) break;
    payloads.push(text.slice(open + OPEN.length, close));
    idx = close + CLOSE.length;
  }
  return payloads;
}

/**
 * Parse one candidate payload into inline comments via the candidate chain:
 *   1. raw payload (may be a fenced ```json array)
 *   2. payload with a leading ```json / ``` fence stripped
 *   3. first balanced `[...]` anywhere in the payload
 *
 * Returns the validated comments (possibly empty — a JSON array that parsed
 * but held zero valid entries), or null when no candidate parses as a JSON
 * array at all. The null distinction lets the caller keep scanning other
 * blocks instead of stopping at a prose candidate that isn't JSON.
 */
function parsePayload(payload: string): InlineComment[] | null {
  const candidates: string[] = [payload];

  const fence = payload.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) candidates.push(fence[1]);

  // Brace-balanced extraction as a last resort (handles trailing prose).
  // Skip when it equals payload to avoid a duplicate tryParseArray pass.
  const balanced = extractFirstJsonArray(payload);
  if (balanced && balanced !== payload) candidates.push(balanced);

  for (const candidate of candidates) {
    const arr = tryParseArray(candidate);
    if (arr !== null) {
      const comments: InlineComment[] = [];
      for (const entry of arr) {
        const c = toInlineComment(entry);
        if (c !== null) comments.push(c);
      }
      return comments;
    }
    // Lenient fallback: the whole array failed to parse (usually one entry
    // with an unescaped quote inside a body string — the coordinator often
    // uses `"..."` Chinese-style quotes without escaping). Parse each entry
    // independently and keep the valid ones, so one bad entry doesn't sink
    // the whole block. Returns [] if nothing parses — same as a parsed-but-
    // empty array.
    const lenient = parseEntriesLenient(candidate);
    if (lenient.length > 0) return lenient;
  }
  return null;
}

/**
 * Parse structured inline comments from coordinator markdown.
 *
 * Returns the validated subset (possibly empty). Never throws: a missing or
 * malformed block degrades to [] so callers can branch on length alone.
 *
 * Scans every `<inline_comments>` candidate block and returns the first that
 * yields valid comments. This handles self-referential coordinator output
 * where the tag name appears in prose or inside a JSON body string value
 * before the real block — those false candidates don't parse as a JSON array
 * of comments and are skipped.
 */
export function parseInlineComments(text: string): InlineComment[] {
  for (const payload of extractAllBlocks(text)) {
    if (payload.trim().length === 0) continue;
    const comments = parsePayload(payload);
    if (comments !== null && comments.length > 0) return comments;
  }
  return [];
}
