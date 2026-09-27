/**
 * The review anchor: the hidden fingerprint (self marker + reviewed head
 * SHA) embedded at the top of every standing PR comment. Shared by the
 * comment posters (pr-comment.ts, Gitea adapter) and the incremental-review
 * resolver (index.ts), so there is exactly one grammar for answering "which
 * commit did we last review".
 *
 * Comment shape (first lines of every posted body):
 *   <!-- pi-review-agent -->
 *   <!-- pi-review-agent-sha:<40-hex sha> -->
 *   ...body...
 *
 * Pure: no fs, no network.
 */

export const SELF_MARKER = "<!-- pi-review-agent -->";
export const SHA_LINE_PREFIX = "<!-- pi-review-agent-sha:";
export const SHA_LINE_SUFFIX = " -->";

/** Full 40-hex commit ids (what headSha env injects) plus >=7 short ids,
 *  case-insensitive, so a hand-truncated anchor still resolves. */
const SHA_RE = /^[0-9a-f]{7,40}$/i;

/** Parse the reviewed-SHA fingerprint out of a comment body. Returns the sha
 *  string, or null when the body carries no fingerprint (a comment from
 *  before the sha line existed, or somebody else's comment). */
export function parseAnchorSha(body: string | null): string | null {
  if (!body) return null;
  const start = body.indexOf(SHA_LINE_PREFIX);
  if (start < 0) return null;
  const shaStart = start + SHA_LINE_PREFIX.length;
  const end = body.indexOf(SHA_LINE_SUFFIX, shaStart);
  if (end < 0) return null;
  const sha = body.slice(shaStart, end).trim();
  return SHA_RE.test(sha) ? sha : null;
}

export interface ReviewAnchorComment {
  id: number;
  body: string | null;
}

/** The anchor consumed by incremental review: the sha a prior round reviewed
 *  plus the comment body it posted (the previous findings). */
export interface ReviewAnchor {
  sha: string;
  body: string;
}

/**
 * Pick the LATEST self-posted comment carrying a fingerprint. Selection is by
 * id, not array order — the issue-comments endpoints return chronological
 * order today, but a differently sorted page must not regress the anchor to
 * an older round. Comments without a fingerprint (first-generation comments,
 * human comments that quoted the marker) are skipped.
 */
export function latestReviewAnchor(
  comments: readonly ReviewAnchorComment[],
): ReviewAnchor | null {
  let bestId = -1;
  let best: ReviewAnchor | null = null;
  for (const c of comments) {
    const sha = parseAnchorSha(c.body);
    if (sha === null) continue;
    if (c.id > bestId) {
      bestId = c.id;
      best = { sha, body: c.body ?? "" };
    }
  }
  return best;
}
