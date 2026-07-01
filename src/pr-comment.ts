/**
 * Post or update a PR comment. The comment carries a hidden marker so we can
 * find our own prior comment and edit it in place across re-runs (instead of
 * spamming new comments on every push).
 *
 * Uses the GitHub REST API via GITHUB_TOKEN. Falls back to no-op (with a
 * warning on stderr) if token or PR context is missing, so the review itself
 * never fails just because comment posting did.
 */
import type { InlineComment, InlineSeverity } from "./inline-comments.js";

/**
 * Hard timeout for every GitHub API call in this module. Without it a slow
 * or wedged response hangs the action until GitHub's 6-hour job timeout.
 * 30s is generous for a normal POST while bounding the wait so the fallback
 * chain can move on. Applied centrally in fetchJson (covers postPrComment)
 * and fetchWithTimeout (covers postPrReview's direct fetches).
 */
const FETCH_TIMEOUT_MS = 30_000;

function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

/** Emoji prefix per severity bucket, added to inline-comment bodies at render
 *  time. Matches the verdict-gate vocabulary (severity.ts), not display-only
 *  palettes: blocking/warning/suggestion group by merge impact. */
const SEVERITY_EMOJI: Record<InlineSeverity, string> = {
  blocking: "🔴",
  warning: "🟡",
  suggestion: "🔵",
};

const MARKER = "<!-- pi-review-agent -->";

export interface PrCommentContext {
  /** GitHub API base, e.g. https://api.github.com. */
  apiBase: string;
  /** Owner/repo, e.g. "sun-praise/pi-review-agent". */
  repository: string;
  /** PR number. */
  pr: number;
  /** GitHub token with PR comment write scope. */
  token: string;
  /**
   * PR head commit SHA. Comments are de-duplicated per head SHA: a re-run on
   * the same SHA edits the prior comment in place, while a new commit (e.g.
   * a push fixing review feedback) posts a fresh comment so the review
   * iteration history stays visible. Empty when not injected (e.g. stale
   * action.yml); in that case we always create, never edit.
   */
  headSha: string;
}

interface GithubComment {
  id: number;
  body: string | null;
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const res = await fetchWithTimeout(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub API ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
  }
  return res.json();
}

const SHA_LINE_PREFIX = "<!-- pi-review-agent-sha:";
const SHA_LINE_SUFFIX = " -->";

/**
 * Find a prior review comment posted for the same head SHA. Returns its id,
 * or undefined when none matches (different SHA, first run on this SHA, or
 * legacy comment without the sha line).
 */
function findUpdatable(
  comments: GithubComment[],
  sha: string,
): number | undefined {
  const target = `${SHA_LINE_PREFIX}${sha}${SHA_LINE_SUFFIX}`;
  for (const c of comments) {
    if (c.body !== null && c.body.includes(MARKER) && c.body.includes(target)) {
      return c.id;
    }
  }
  return undefined;
}


async function listComments(ctx: PrCommentContext): Promise<GithubComment[]> {
  const url = `${ctx.apiBase}/repos/${ctx.repository}/issues/${ctx.pr}/comments`;
  const data = (await fetchJson(url, {
    headers: {
      Authorization: `Bearer ${ctx.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  })) as GithubComment[];
  return Array.isArray(data) ? data : [];
}

async function createComment(ctx: PrCommentContext, body: string): Promise<void> {
  const url = `${ctx.apiBase}/repos/${ctx.repository}/issues/${ctx.pr}/comments`;
  await fetchJson(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ctx.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body }),
  });
}

async function updateComment(
  ctx: PrCommentContext,
  id: number,
  body: string,
): Promise<void> {
  const url = `${ctx.apiBase}/repos/${ctx.repository}/issues/comments/${id}`;
  await fetchJson(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${ctx.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body }),
  });
}

/** Post or update the comment. Returns the action taken, or null if skipped. */
export async function postPrComment(
  ctx: PrCommentContext,
  body: string,
): Promise<"created" | "updated" | "skipped"> {
  if (!ctx.token) {
    process.stderr.write("postPrComment: no GITHUB_TOKEN; skipping\n");
    return "skipped";
  }
  const head = ctx.headSha
    ? `${MARKER}\n${SHA_LINE_PREFIX}${ctx.headSha}${SHA_LINE_SUFFIX}`
    : MARKER;
  const payload = `${head}\n${body}`;
  try {
    if (ctx.headSha) {
      const existing = await listComments(ctx);
      const id = findUpdatable(existing, ctx.headSha);
      if (id !== undefined) {
        await updateComment(ctx, id, payload);
        return "updated";
      }
    }
    await createComment(ctx, payload);
    return "created";
  } catch (err: unknown) {
    process.stderr.write(
      `postPrComment: failed (${err instanceof Error ? err.message : String(err)}); skipping\n`,
    );
    return "skipped";
  }
}

/**
 * Resolve PR comment context from the standard GitHub Actions env. Returns
 * null when not in an action or when the event isn't a PR.
 */
export function prCommentContextFromEnv(env: NodeJS.ProcessEnv): PrCommentContext | null {
  const ref = env.GITHUB_REF ?? "";
  const match = ref.match(/refs\/pull\/(\d+)\//);
  if (!match) return null;
  const pr = Number(match[1]);
  const repository = env.GITHUB_REPOSITORY ?? "";
  if (!repository) return null;
  const token = env.GITHUB_TOKEN ?? "";
  return {
    apiBase: env.GITHUB_API_URL ?? "https://api.github.com",
    repository,
    pr,
    token,
    headSha: env.PI_REVIEW_HEAD_SHA ?? "",
  };
}

/**
 * Post a PR review with inline comments via the GitHub Reviews API, with a
 * three-stage fallback chain so the verdict always lands somewhere:
 *
 *   1. review + inline comments (the goal — findings pinned to diff lines)
 *   2. summary-only review (same reviews endpoint, comments dropped) — used
 *      when GitHub rejects the inline batch, typically because a comment's
 *      line falls outside the diff hunks (server-side validation rejects the
 *      whole batch at once)
 *   3. plain issue comment via postPrComment (edit-in-place, never fails)
 *
 * Reviews are not editable in place the way issue comments are, so each run
 * posts a fresh review. This is acceptable: each commit's review is a
 * distinct artifact, and the summary review mirrors the verdict the issue
 * comment would have carried.
 *
 * Only call this when `comments.length > 0` — without inline findings there
 * is no benefit over postPrComment's edit-in-place summary, which avoids
 * stacking duplicate reviews on re-pushes of the same SHA.
 *
 * Never throws: a network or API failure falls through to postPrComment,
 * which itself degrades to "skipped" on error.
 */
export async function postPrReview(
  ctx: PrCommentContext,
  summary: string,
  comments: InlineComment[],
): Promise<"review" | "summary-review" | "created" | "updated" | "skipped"> {
  // Caller guards comments.length > 0, but defend anyway: with no inline
  // data there's nothing the Reviews API offers over an issue comment.
  if (comments.length === 0) {
    return postPrComment(ctx, summary);
  }
  // Reviews API needs commit_id to anchor inline comments to a specific
  // patch. Without headSha we can't post inline comments at all.
  if (!ctx.headSha) {
    return postPrComment(ctx, summary);
  }
  if (!ctx.token) {
    process.stderr.write("postPrReview: no GITHUB_TOKEN; skipping\n");
    return "skipped";
  }

  const headers = {
    Authorization: `Bearer ${ctx.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
  const url = `${ctx.apiBase}/repos/${ctx.repository}/pulls/${ctx.pr}/reviews`;


  const inlinePayload = comments.map((c) => ({
    path: c.file,
    line: c.line,
    side: c.side,
    body: `${SEVERITY_EMOJI[c.severity]} ${c.body}`,
  }));

  // Attempt 1: review carrying the inline comments.
  try {
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        commit_id: ctx.headSha,
        body: summary,
        event: "COMMENT",
        comments: inlinePayload,
      }),
    });
    if (res.ok) {
      process.stdout.write(
        `postPrReview: posted review with ${inlinePayload.length} inline comment(s)\n`,
      );
      return "review";
    }
    const errBody = await res.text().catch(() => "");
    process.stderr.write(
      `postPrReview: inline review rejected (${res.status}); retrying as summary review. ${errBody.slice(0, 500)}\n`,
    );
  } catch (err: unknown) {
    process.stderr.write(
      `postPrReview: inline review threw (${err instanceof Error ? err.message : String(err)}); retrying as summary review\n`,
    );
  }

  // Attempt 2: summary-only review — drop the inline batch, keep the review
  // anchored to this commit. Cheaper than an issue comment for users who
  // filter on review state, and still a single PR artifact per run.
  try {
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        commit_id: ctx.headSha,
        body: summary,
        event: "COMMENT",
        comments: [],
      }),
    });
    if (res.ok) {
      process.stderr.write("postPrReview: posted summary-only review\n");
      return "summary-review";
    }
    const errBody = await res.text().catch(() => "");
    process.stderr.write(
      `postPrReview: summary review rejected (${res.status}); falling back to issue comment. ${errBody.slice(0, 500)}\n`,
    );
  } catch (err: unknown) {
    process.stderr.write(
      `postPrReview: summary review threw (${err instanceof Error ? err.message : String(err)}); falling back to issue comment\n`,
    );
  }

  // Attempt 3: issue comment with edit-in-place. postPrComment maps its own
  // failures to "skipped", so we just pass the outcome through.
  return postPrComment(ctx, summary);
}
