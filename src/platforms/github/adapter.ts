/**
 * GitHub platform adapter implementation.
 * Wraps existing github-context.ts and pr-comment.ts functionality.
 */

import type { PlatformAdapter, PrContextOptions, PrCommentContext, PrInfo, InlineComment, PostReviewResult, CompareDiffOptions } from "../types.js";
import type { ReviewAnchor, ReviewAnchorComment } from "../../review-anchor.js";
import { latestReviewAnchor } from "../../review-anchor.js";
import { lastPageUrl } from "../pagination.js";
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
      if (selfLogin !== null) {
        // Strict identity: only comments authored by the token's own login.
        const anchor = latestReviewAnchor(comments, selfLogin);
        if (!anchor) {
          const fingerprinted = comments.filter(
            (c) => c.body?.includes("<!-- pi-review-agent-sha:"),
          ).length;
          if (fingerprinted > 0) {
            process.stderr.write(
              `getLastReviewAnchor: ${fingerprinted} fingerprinted comment(s) exist but none is authored by ${selfLogin} — no trusted anchor, full review\n`,
            );
          }
        }
        return anchor;
      }
      // Degraded identity — the typical case for the default github.token:
      // installation tokens get 403 from GET /user. Require a Bot author
      // instead: the agent posts as a bot (github-actions[bot] or an app),
      // and human PR authors cannot author Bot-type comments. Not as strict
      // as a login match (another installed app could forge), but a far
      // higher bar than marker+fingerprint alone.
      process.stderr.write(
        "getLastReviewAnchor: token login unresolvable (installation token?); " +
          "anchor identity check degraded to Bot-type authors\n",
      );
      const botComments = comments.filter((c) => c.accountType === "Bot");
      return latestReviewAnchor(botComments, undefined);
    } catch (err: unknown) {
      process.stderr.write(
        `getLastReviewAnchor: failed (${err instanceof Error ? err.message : String(err)}); incremental falls back to a full review\n`,
      );
      return null;
    }
  }

  /** Issue comments for anchor selection: the first page plus — when GitHub
   *  paginates (Link header) — a direct jump to the LAST page, where the
   *  newest anchor lives. Selection is by id, so which pages were seen
   *  doesn't matter as long as the newest one is among them. */
  private async listAnchorComments(options: PrContextOptions): Promise<ReviewAnchorComment[]> {
    const first = await this.fetchCommentPage(options, 1);
    const comments = [...first.comments];
    const lastUrl = lastPageUrl(first.linkHeader);
    if (lastUrl !== null && lastUrl !== first.url) {
      const last = await this.fetchCommentPage(options, -1, lastUrl);
      comments.push(...last.comments);
    }
    return comments;
  }

  /** One page of issue comments. `page < 0` fetches `url` verbatim (a Link
   *  header target); otherwise the documented per_page/page params. */
  private async fetchCommentPage(
    options: PrContextOptions,
    page: number,
    url?: string,
  ): Promise<{ url: string; linkHeader: string | null; comments: ReviewAnchorComment[] }> {
    const target =
      page < 0 && url
        ? url
        : `${options.apiBase}/repos/${options.repository}/issues/${options.pr}/comments?per_page=100&page=${page}`;
    const res = await fetch(target, {
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
    const comments: ReviewAnchorComment[] = [];
    if (Array.isArray(data)) {
      for (const c of data) {
        if (typeof c !== "object" || c === null) continue;
        if (!("id" in c && "body" in c && "user" in c)) continue;
        const user = c.user;
        const login =
          typeof user === "object" && user !== null && "login" in user && typeof user.login === "string"
            ? user.login
            : undefined;
        const accountType =
          typeof user === "object" && user !== null && "type" in user && typeof user.type === "string"
            ? user.type
            : undefined;
        if (typeof c.id === "number" && (typeof c.body === "string" || c.body === null)) {
          comments.push({ id: c.id, body: c.body, login, accountType });
        }
      }
    }
    return { url: target, linkHeader: res.headers.get("link"), comments };
  }

  /** The token's own login (GET /user) so anchor candidates can be filtered
   *  by author. Null when unresolvable (403 for installation tokens, e.g.
   *  the default github.token) — see getLastReviewAnchor for the degraded
   *  path. A resolved login that matches no comment rejects all anchors:
   *  the run degrades to a full review (fail-open, logged there). */
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
