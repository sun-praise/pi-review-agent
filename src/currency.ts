/**
 * Display-currency resolution and formatting, pure (no pi-ai imports) so it
 * stays testable under `node --test`.
 *
 * Internal cost accounting is ALWAYS USD (pi-ai's Model.cost semantics, the
 * `cost-overrides` input, and the GITHUB_OUTPUT machine contract). Currency
 * conversion happens at the DISPLAY layer only (PR comment, step summary,
 * stdout) — see #57 for the agreed design.
 *
 * Fail-open contract: an invalid currency or exchange rate never fails a
 * review run. resolveCurrencyOptions returns warnings and falls back to the
 * defaults; the caller surfaces the warnings on stderr.
 */

export type DisplayCurrency = "usd" | "cny";

/** Fallback USD→CNY rate when the user selects cny without overriding.
 *  Mid-range of recent USD/CNY; stale by definition — users who care about
 *  precision set `exchange-rate` explicitly. */
export const DEFAULT_USD_CNY_RATE = 7.2;

export interface CurrencyOptions {
  currency: DisplayCurrency;
  /** USD→CNY multiplier; only consulted when currency is "cny". */
  rate: number;
}

export interface ResolvedCurrency extends CurrencyOptions {
  /** Human-readable complaints for invalid input; empty when all clean. */
  warnings: string[];
}

/** Parse + validate the currency/exchange-rate option pair. Pure: returns
 *  warnings instead of writing stderr, so tests assert them directly. */
export function resolveCurrencyOptions(
  rawCurrency: string | undefined,
  rawRate: string | undefined,
): ResolvedCurrency {
  const warnings: string[] = [];
  let currency: DisplayCurrency = "usd";
  const currencyRaw = rawCurrency?.trim().toLowerCase();
  if (currencyRaw === undefined || currencyRaw === "") {
    // unset — default
  } else if (currencyRaw === "usd" || currencyRaw === "cny") {
    currency = currencyRaw;
  } else {
    warnings.push(`currency "${rawCurrency}" not recognized (usd|cny); defaulting to usd`);
  }

  let rate = DEFAULT_USD_CNY_RATE;
  if (rawRate !== undefined && rawRate.trim() !== "") {
    const parsed = Number(rawRate);
    if (Number.isFinite(parsed) && parsed > 0) {
      rate = parsed;
    } else {
      warnings.push(`exchange-rate "${rawRate}" must be a positive number; defaulting to ${rate}`);
    }
  }
  return { currency, rate, warnings };
}

/** Format a USD cost amount for display in the configured currency.
 *  `$0.000123` / `¥0.000891` — six decimals regardless of currency, matching
 *  the existing USD rendering. */
export function formatCost(usd: number, opts: CurrencyOptions): string {
  return opts.currency === "cny"
    ? `¥${(usd * opts.rate).toFixed(6)}`
    : `$${usd.toFixed(6)}`;
}
