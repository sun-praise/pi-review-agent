/**
 * The review anchor: the hidden fingerprint (self marker + reviewed head
 * SHA) embedded at the top of every standing PR comment. Shared by the
 * comment posters (pr-comment.ts, Gitea adapter) and the incremental-review
 * resolver (incremental.ts), so there is exactly one grammar for answering
 * "which commit did we last review".
 *
 * Comment shape (first lines of every posted body):
 *   <!-- pi-review-agent -->
 *   <!-- pi-review-agent-sha:<40-hex sha> -->
 *   ...body...
 *
 * Anchor selection is identity-checked: a candidate must carry BOTH the
 * self marker and the sha fingerprint, and — when the caller resolved the
 * token's own login — must be authored by that login. The fingerprint alone
 * is not proof of origin: it is a hidden HTML comment anyone can copy into
 * their own comment, and a forged anchor would steer the next run's delta
 * away from unreviewed commits while injecting an attacker-written
 * "previous review" into the prompts.
 *
 * Pure: no fs, no network.
 */

export const SELF_MARKER = "<!-- pi-review-agent -->";
export const SHA_LINE_PREFIX = "<!-- pi-review-agent-sha:";
export const SHA_LINE_SUFFIX = " -->";

/** Identity marker of the standing skip notice (#88) — the marker-keyed
 * comment that makes a max-reviews-per-pr skip visible in the PR
 * conversation. Deliberately NOT part of the anchor grammar above: a notice
 * body must never carry SELF_MARKER or the sha fingerprint, or
 * latestReviewAnchor would parse a skipped commit as reviewed and steer the
 * next incremental delta past unreviewed changes. */
export const SKIP_NOTICE_MARKER = "<!-- pi-review-agent-skip-notice -->";

/** Full 40-hex commit ids (what headSha env injects) plus >=7 short ids,
 *  case-insensitive, so a hand-truncated anchor still resolves. */
const SHA_RE = /^[0-9a-f]{7,40}$/i;

/** Parse the reviewed-SHA fingerprint out of a comment body. Returns the sha
 *  string, or null when the body carries no fingerprint (a comment from
 *  before the sha line existed, or somebody else's comment). NOTE: presence
 *  of the fingerprint alone does NOT make a comment an anchor — see
 *  latestReviewAnchor for the marker/identity checks. */
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
  /** Author login, when the listing provides it. Checked against the
   *  token's own identity (selfLogin) whenever that is known, so a forged
   *  fingerprint posted by anyone else cannot steer the anchor. */
  login?: string;
  /** Author account type ("User" | "Bot" | ...), when the listing provides
   *  it. Used by callers whose token cannot resolve its own login
   *  (installation tokens 403 on GET /user): the degraded check requires a
   *  Bot author, which human commenters cannot fake. */
  accountType?: string;
}

/** The anchor consumed by incremental review: the sha a prior round reviewed
 *  plus the comment body it posted (the previous findings). */
export interface ReviewAnchor {
  sha: string;
  body: string;
}

/**
 * Pick the LATEST eligible anchor comment: self marker + fingerprint, and —
 * when `selfLogin` is given — authored by that login (undefined = identity
 * unknown, e.g. the /user lookup failed; marker+fingerprint still required).
 * Selection is by id, not array order — the issue-comments endpoints return
 * chronological order today, but a differently sorted page must not regress
 * the anchor to an older round.
 */
export function latestReviewAnchor(
  comments: readonly ReviewAnchorComment[],
  selfLogin?: string,
): ReviewAnchor | null {
  let bestId = -1;
  let best: ReviewAnchor | null = null;
  for (const c of comments) {
    if (!c.body || !c.body.includes(SELF_MARKER)) continue;
    const sha = parseAnchorSha(c.body);
    if (sha === null) continue;
    if (selfLogin !== undefined && c.login !== selfLogin) continue;
    if (c.id > bestId) {
      bestId = c.id;
      best = { sha, body: c.body };
    }
  }
  return best;
}
