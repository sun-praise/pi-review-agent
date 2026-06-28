/**
 * Classify an error as transient (worth retrying) vs permanent.
 *
 * Split into its own module so it can be unit-tested without pulling in the
 * review runtime (which drags in @earendil-works/pi-agent-core and its
 * `exports` map that tsx cannot resolve under `node --test`).
 *
 * Pure: no env, no fs, no side effects.
 */

/**
 * pi-ai surfaces upstream stream resets as generic fetch failures; on long
 * reviews a single blip can wipe out a reviewer mid-stream. That must not
 * permanently fail the review. Our OWN deadline ("<label> timed out after
 * Nms") is excluded — it means the budget is spent, so retrying would just
 * immediately re-expire. HTTP 429 (rate-limit) and 5xx are transient; other
 * 4xx are permanent (a 413 on a large diff won't fix itself on retry).
 */
export function isTransientReviewerError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (/\btimed out after \d+ms\b/.test(msg)) return false;
  // 429 = rate-limit: transient. Check BEFORE the 4xx exclusion so it wins
  // (the \b4[0-8]\d\b pattern below would otherwise swallow 429).
  if (/\brate limit\b|\b429\b/i.test(msg)) return true;
  // Other 4xx are permanent: a 413 on a large diff won't resolve by retrying
  // the same payload — it only burns time and re-imposes identical load.
  if (/\b4[0-8]\d\b/.test(msg)) return false;
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EHOSTUNREACH|ENETUNREACH|UND_ERR|socket hang up|other side closed|request timeout|stream timeout|stream terminated|connection terminated|\b5\d\d\b/i.test(
    msg,
  );
}
