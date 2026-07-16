/**
 * Parse a comma-separated fallback-model spec into a list of model ids.
 *
 * Accepts the raw string form used by the CLI/Action (`--fallback-models`,
 * `PI_REVIEW_FALLBACK_MODELS`) and returns the normalized ids. Empty/blank
 * input and empty segments are dropped, so an empty string disables fallback.
 *
 * Kept in its own module (rather than `index.ts`) so the unit test can import
 * it without pulling in the CLI's heavy dependency graph.
 */
export function parseFallbackModels(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}
