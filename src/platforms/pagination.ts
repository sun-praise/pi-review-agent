/**
 * Pagination planning for anchor-comment lookups. Pure — the adapters feed
 * header-derived totals and get the page numbers to fetch. Kept out of the
 * adapters (which drag network stacks and can't be loaded under
 * `node --test`) so the planning is unit-testable.
 */

/** Gitea: total pages seen per anchor lookup, first page included. */
export const GITEA_ANCHOR_PAGE_CAP = 5;

/**
 * Which pages BEYOND the first a Gitea anchor lookup should fetch.
 *
 * X-Total-Count known → jump to the END: the newest anchor lives on the
 * last page, so we fetch the newest (cap − 1) pages, not the oldest — a
 * busy PR's anchor must not be stranded past the window while pages 2..5
 * of 2017 fetch the oldest comments instead.
 *
 * Header absent (some Gitea versions / header-stripping proxies) → walk
 * forward from page 2; the CALLER stops at the first short page, which
 * reaches the true end only within the cap — beyond it the lookup misses
 * and the run degrades to a full review (fail-open).
 */
export function planGiteaPages(
  total: number | null,
  limit: number,
  cap: number = GITEA_ANCHOR_PAGE_CAP,
): number[] {
  if (total === null) {
    const forward: number[] = [];
    for (let page = 2; page <= cap; page++) forward.push(page);
    return forward;
  }
  const pages = Math.max(1, Math.ceil(total / limit));
  // Newest (cap − 1) pages beyond the first; for short PRs that is simply
  // "all remaining pages".
  const start = Math.max(2, pages - (cap - 2));
  const out: number[] = [];
  for (let page = start; page <= pages; page++) out.push(page);
  return out;
}

/**
 * Extract the rel="last" target from a GitHub Link header, if present.
 * GitHub paginates via this header (documented in the REST pagination
 * guide), which lets the anchor lookup jump straight to the newest page
 * in two requests instead of walking.
 */
export function lastPageUrl(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    if (part.includes('rel="last"')) {
      const match = part.match(/<([^>]+)>/);
      if (match) return match[1] ?? null;
    }
  }
  return null;
}
