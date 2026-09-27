/**
 * GitHub platform adapter implementation.
 * Wraps existing github-context.ts and pr-comment.ts functionality.
 */

import type { PlatformAdapter, PrContextOptions, PrCommentContext, PrInfo, InlineComment, PostReviewResult, CompareDiffOptions } from "../types.js";
import type { ReviewAnchor, ReviewAnchorComment } from "../../review-anchor.js";
import { latestReviewAnchor } from "../../review-anchor.js";
import { fetchPrContext, githubAuthFromEnv } from "../../github-context.js";
import { postPrComment, postPrReview } from "../../pr-comment.js";

export class GitHubAdapter implements PlatformAdapter {
  async fetchPrContext(options: PrContextOptions): Promise<string> {
    return fetchPrContext(options);
  }

  async getLastReviewAnchor(options: PrContextOptions): Promise<ReviewAnchor | null> {
    if (!options.token) return null;
    try {
      const [comments, selfLogin] = await Promise.all([
        this.listAnchorComments(options),
        this.resolveSelfLogin(options),
      ]);
      return latestReviewAnchor(comments, selfLogin ?? undefined);
    } catch (err: unknown) {
      process.stderr.write(
        `getLastReviewAnchor: failed (${err instanceof Error ? err.message : String(err)}); incremental falls back to a full review\n`,
      );
      return null;
    }
  }

  /** One desc-ordered page of issue comments, narrowed to the fields the
   *  anchor selection needs (id, body, author login). */
  private async listAnchorComments(options: PrContextOptions): Promise<ReviewAnchorComment[]> {
    const url =
      `${options.apiBase}/repos/${options.repository}/issues/${options.pr}/comments?per_page=100&sort=created&direction=desc`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${options.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`GitHub API ${res.status} ${res.statusText}`);
    }
    const data: unknown = await res.json();
    if (!Array.isArray(data)) return [];
    const comments: ReviewAnchorComment[] = [];
    for (const c of data) {
      if (typeof c !== "object" || c === null) continue;
      if (!("id" in c && "body" in c && "user" in c)) continue;
      const user = c.user;
      const login =
        typeof user === "object" && user !== null && "login" in user && typeof user.login === "string"
          ? user.login
          : undefined;
      if (typeof c.id === "number" && (typeof c.body === "string" || c.body === null)) {
        comments.push({ id: c.id, body: c.body, login });
      }
    }
    return comments;
  }

  /** The token's own login (GET /user) so anchor candidates can be filtered
   *  by author. Null when unresolvable — selection then degrades to
   *  marker+fingerprint (see review-anchor.ts). */
  private async resolveSelfLogin(options: PrContextOptions): Promise<string | null> {
    try {
      const res = await fetch(`${options.apiBase}/user`, {
        headers: {
          Authorization: `Bearer ${options.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        await res.body?.cancel();
        process.stderr.write(
          `getLastReviewAnchor: /user returned ${res.status}; anchor identity check degrades to marker+fingerprint\n`,
        );
        return null;
      }
      const data: unknown = await res.json();
      if (typeof data === "object" && data !== null && "login" in data && typeof data.login === "string") {
        return data.login;
      }
      return null;
    } catch {
      return null;
    }
  }

  async fetchCompareDiff(options: CompareDiffOptions): Promise<string | null> {
    if (!options.token) return null;
    const url =
      `${options.apiBase}/repos/${options.repository}/compare/${options.base}...${options.head}`;
    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${options.token}`,
          // Diff media type on the compare endpoint: the JSON shape carries
          // per-file patches that would need lossy reassembly.
          Accept: "application/vnd.github.v3.diff",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        // Release the connection instead of leaving it for GC (undici keeps
        // the socket busy until the body is consumed or cancelled).
        await res.body?.cancel();
        return null;
      }
      return await res.text();
    } catch {
      return null;
    }
  }

  async postComment(context: PrCommentContext, body: string): Promise<"created" | "updated" | "skipped"> {
    return postPrComment(context, body);
  }

  async postReview(
    context: PrCommentContext,
    summary: string,
    comments: InlineComment[],
    commentFallback?: string,
  ): Promise<PostReviewResult> {
    return postPrReview(context, summary, comments, commentFallback);
  }

  resolvePrFromEnv(env: NodeJS.ProcessEnv): PrInfo | null {
    const auth = githubAuthFromEnv(env);
    if (!auth) return null;

    // Extract PR number from GITHUB_REF
    const ref = env.GITHUB_REF ?? "";
    const match = ref.match(/refs\/pull\/(\d+)\//);
    if (!match) return null;

    return {
      pr: Number(match[1]),
      repository: auth.repository,
      apiBase: auth.apiBase,
      token: auth.token,
      headSha: env.PI_REVIEW_HEAD_SHA ?? "",
    };
  }
}
