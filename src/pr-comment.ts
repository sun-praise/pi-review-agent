/**
 * Post or update a PR comment. The comment carries a hidden marker so we can
 * find our own prior comment and edit it in place across re-runs (instead of
 * spamming new comments on every push).
 *
 * Uses the GitHub REST API via GITHUB_TOKEN. Falls back to no-op (with a
 * warning on stderr) if token or PR context is missing, so the review itself
 * never fails just because comment posting did.
 */

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
  const res = await fetch(url, init);
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
