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

function hasMarker(body: string | null): boolean {
  return body !== null && body.includes(MARKER);
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

export function withMarker(body: string): string {
  return `${MARKER}\n${body}`;
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
  const payload = withMarker(body);
  try {
    const existing = await listComments(ctx);
    const own = existing.find((c) => hasMarker(c.body));
    if (own) {
      await updateComment(ctx, own.id, payload);
      return "updated";
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
  if (!token) return null;
  return {
    apiBase: env.GITHUB_API_URL ?? "https://api.github.com",
    repository,
    pr,
    token,
  };
}
