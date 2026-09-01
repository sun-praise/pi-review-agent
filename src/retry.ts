/**
 * Retry an async operation on transient failures with exponential backoff.
 *
 * Reuses isTransientReviewerError for classification: network blips (fetch
 * failed, ECONNRESET, ...), HTTP 429, and 5xx retry; permanent errors (other
 * 4xx, our own deadline) rethrow immediately. Added for PR-comment posting
 * (#59): a single transient fetch failure on a self-hosted runner used to
 * discard a finished review with only a stderr warning.
 */
import { isTransientReviewerError } from "./transient-error.js";

export interface RetryOptions {
  /** Diagnostic label for the retry warning on stderr. */
  label: string;
  /** Total attempts including the first. Default 3. */
  attempts?: number;
  /** Base backoff in ms; grows ×2 per retry plus random jitter. Default 1000. */
  baseMs?: number;
}

export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseMs = opts.baseMs ?? 1000;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;
      if (attempt >= attempts || !isTransientReviewerError(err)) throw err;
      // Jitter (matching runModelAttempt's convention): several personas
      // finish together and can fail together; without jitter their retry
      // sequences align and re-burst in lockstep.
      const backoff = baseMs * 2 ** (attempt - 1) + Math.random() * baseMs;
      process.stderr.write(
        `${opts.label}: attempt ${attempt}/${attempts} failed ` +
          `(${err instanceof Error ? err.message : String(err)}); retrying in ${backoff}ms\n`,
      );
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, backoff);
      await promise;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`${opts.label}: failed without a captured error`);
}
