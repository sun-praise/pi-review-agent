/**
 * Per-model cost tables, pure (no pi-ai imports) so it stays testable under
 * `node --test`.
 *
 * The provider registers every model id the run may request (#44/#45:
 * primary + per-role overrides + fallback chain), but the upstream only knows
 * one real price list — DeepSeek's. Without overrides, every id is billed in
 * summaries at DeepSeek-flash rates (#47). `cost-overrides` lets the user
 * supply the real price table per model id (USD per 1M tokens, matching
 * pi-ai's Model.cost semantics).
 */

/** Cost table matching pi-ai's `Model.cost` shape: USD per 1M tokens.
 *  `cacheRead` is the discounted rate for cache-hit input tokens. */
export interface ModelCostTable {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
/** DeepSeek public pricing (deepseek-v4-flash rates) — the default estimate
 *  stamped on every id WITHOUT an explicit override. Lookup at registration:
 *  `costByModel?.[id] ?? DEFAULT_DEEPSEEK_COST` — overrides replace wholesale,
 *  since a different model's prices are not DeepSeek's with one field patched.
 *  Single source: provider.ts builds its cost tables from this constant. */
export const DEFAULT_DEEPSEEK_COST: ModelCostTable = {
  input: 0.14,
  output: 0.28,
  cacheRead: 0.0028,
  cacheWrite: 0,
};

export type ParseCostResult =
  | { ok: true; costs: Record<string, ModelCostTable> }
  | { ok: false; error: string };

/**
 * Parse a `cost-overrides` JSON string: `{"<model-id>": {"input": 0.5,
 * "output": 1.2, "cacheRead": 0.05}}`. `input`/`output` are required per
 * entry; `cacheRead`/`cacheWrite` default to 0 (no discount unless stated).
 * Every price must be a FINITE NON-NEGATIVE number — negative or infinite
 * values are rejected with the whole parse (they would silently poison
 * cost-based decisions). Empty/undefined input parses to an empty map. Any
 * malformed input fails the whole parse (ok:false) rather than half-applying
 * — cost figures are decision inputs (#43 benchmark), so silent partial
 * application is worse than an all-or-nothing fallback to defaults.
 */
/** Type guard: a usable price — numbers only, and JSON's `1e999` parses to
 *  Infinity which must not slip through a plain typeof check. */
function isValidPrice(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function parseCostOverrides(raw: string | undefined): ParseCostResult {
  if (!raw || !raw.trim()) return { ok: true, costs: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `invalid JSON (${err instanceof Error ? err.message : String(err)})` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "top-level value must be a JSON object keyed by model id" };
  }
  const costs: Record<string, ModelCostTable> = {};
  for (const [id, value] of Object.entries(parsed)) {
    // JSON.parse creates an OWN "__proto__" property (DefineOwnProperty, no
    // setter), but assigning it into the plain `costs` object below WOULD hit
    // the inherited __proto__ setter and swap the prototype instead of adding
    // a key. Reject the dangerous names outright — they are never valid ids.
    if (id === "__proto__" || id === "constructor" || id === "prototype") {
      return { ok: false, error: `key "${id}" is not a valid model id` };
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { ok: false, error: `entry "${id}" must be an object` };
    }
    const entry = value as Record<string, unknown>;
    if (!isValidPrice(entry.input) || !isValidPrice(entry.output)) {
      return {
        ok: false,
        error: `entry "${id}" requires finite non-negative "input" and "output"`,
      };
    }
    if (
      (entry.cacheRead !== undefined && !isValidPrice(entry.cacheRead)) ||
      (entry.cacheWrite !== undefined && !isValidPrice(entry.cacheWrite))
    ) {
      return {
        ok: false,
        error: `entry "${id}": "cacheRead"/"cacheWrite" must be finite non-negative numbers`,
      };
    }
    costs[id] = {
      input: entry.input,
      output: entry.output,
      cacheRead: typeof entry.cacheRead === "number" ? entry.cacheRead : 0,
      cacheWrite: typeof entry.cacheWrite === "number" ? entry.cacheWrite : 0,
    };
  }
  return { ok: true, costs };
}

