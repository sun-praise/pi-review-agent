/**
 * Pure model-id registration list helper, kept free of pi-ai imports so it
 * stays unit-testable under `node --test` (provider.ts cannot be — its pi-ai
 * import cannot resolve under tsx's CJS test compilation, which is why it is
 * excluded from the test graph like verifier-agent.ts).
 *
 * Contract: EVERY model id that runReview / buildVerifierAgent may request
 * must be registered on the provider — pi-ai's Models.getModel() is a strict
 * find over the registered list and returns undefined (→ "model not found")
 * for anything missing. Callers pass primary + per-role overrides + the whole
 * fallback chain; this helper dedupes and applies the default.
 */

/** Default model when no ids survive filtering — mirrors review.ts's primary
 *  default so an unconfigured run registers exactly what it will request. */
export const DEFAULT_MODEL_ID = "deepseek-v4-flash";

/**
 * Dedupe model ids in first-seen order, dropping empty/undefined entries.
 * Returns ["deepseek-v4-flash"] when nothing remains, so the provider always
 * registers the id the review layer defaults to.
 */
export function resolveModelIds(ids: ReadonlyArray<string | undefined>): string[] {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  return unique.length > 0 ? unique : [DEFAULT_MODEL_ID];
}
