/**
 * Session directory-name resolution — the single source of truth for how a
 * session identity maps onto the filesystem path segment under
 * <sessionsRoot>.
 *
 * Extracted pure (node:path not needed) so the success path (review.ts),
 * the failure path (orchestrate.ts's emptyReview), and the JSON payload
 * (index.ts → json-output.ts) all derive identical names, and so the
 * traversal-shaped inputs (.., ., empty, absolute) are unit-testable
 * without the pi-agent-core runtime.
 *
 * Sanitization contract:
 *   - unsafe characters collapse to "_" (harness ids can carry "/" etc.);
 *   - a sanitized result that is empty, ".", "..", or ".."-prefixed is
 *     UNUSABLE (`.`/`..` escape the root via path.join) and falls back to a
 *     deterministic hash of the original key — deterministic so the same
 *     key always maps to the same dir and resume semantics survive;
 *   - the caller additionally asserts containment on the final file path
 *     (see sessionFile in review.ts) as defense in depth.
 */

/** Resolve the session directory name for a run. */
export function resolveSessionDirName(sessionKey: string | undefined, pr: number): string {
  if (sessionKey === undefined) return String(pr);
  const sanitized = sessionKey.replace(/[^A-Za-z0-9._-]+/g, "_");
  return usableDirName(sanitized) ? sanitized : `key-${fnv1aHex(sessionKey)}`;
}

function usableDirName(name: string): boolean {
  return name.length > 0 && name !== "." && name !== ".." && !name.startsWith("..");
}

/** FNV-1a 32-bit → 8 hex chars. Deterministic, dependency-free. */
function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
