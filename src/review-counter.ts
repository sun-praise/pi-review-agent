/**
 * Per-PR review-round counter for `max-reviews-per-pr` (#84): a durable
 * record of how many review rounds have been dispatched for one session
 * identity (the PR number by default), stored under the sessions root so it
 * rides the same per-PR `actions/cache` entry as the resume JSONL files.
 *
 * Semantics:
 *   - `{"count": N}` in <sessionsRoot>/<sessionDirName>/review-count.json;
 *   - missing, corrupt, or non-finite counts read as 0 — every degradation
 *     (cache evicted, file deleted, unparseable body) fails toward
 *     "review again" (over-review, spends money), never toward silently
 *     stopping reviews;
 *   - the count is a FACT record, not a ban: raising the limit resumes
 *     reviewing, deleting the file resets it.
 *
 * Pure-fs module (no pi-ai imports) so it stays testable under `node --test`
 * (LRN-20260716-002). Concurrent runs on one PR race the read-modify-write
 * last-write-wins — an undercount, same acceptable failure direction.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const REVIEW_COUNT_FILENAME = "review-count.json";

/** Parse a counter file body into a usable count, or null when unusable
 *  (corrupt JSON, wrong shape, negative, non-finite). Callers treat null as
 *  0 — see module doc for why the failure direction must be over-review. */
function parseCount(raw: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const count = (parsed as Record<string, unknown>).count;
  return typeof count === "number" && Number.isFinite(count) && count >= 0 ? count : null;
}

/** Review rounds recorded for this identity. Fail-open: any unusable or
 *  missing file counts as 0. */
export async function readReviewCount(file: string): Promise<number> {
  try {
    return parseCount(await readFile(file, "utf8")) ?? 0;
  } catch {
    return 0;
  }
}

/** Record one more dispatched review round; returns the new count. The
 *  write is fail-open too — a counter problem must never fail the review
 *  itself, so on write failure the run proceeds with a stale count
 *  (undercount, acceptable direction) and a stderr note. */
export async function bumpReviewCount(file: string): Promise<number> {
  const next = (await readReviewCount(file)) + 1;
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify({ count: next })}\n`, "utf8");
  } catch (err: unknown) {
    process.stderr.write(
      `max-reviews-per-pr: counter update failed (${err instanceof Error ? err.message : String(err)}); continuing\n`,
    );
  }
  return next;
}
