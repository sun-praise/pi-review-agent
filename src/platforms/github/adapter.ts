/**
 * GitHub platform adapter implementation.
 * Wraps existing github-context.ts and pr-comment.ts functionality.
 */

import type { PlatformAdapter, PrContextOptions, PrCommentContext, PrInfo, InlineComment, PostReviewResult } from "../types.js";
import { fetchPrContext, githubAuthFromEnv } from "../../github-context.js";
import { postPrComment, postPrReview, prCommentContextFromEnv } from "../../pr-comment.js";

export class GitHubAdapter implements PlatformAdapter {
  async fetchPrContext(options: PrContextOptions): Promise<string> {
    return fetchPrContext(options);
  }

  async postComment(context: PrCommentContext, body: string): Promise<"created" | "updated" | "skipped"> {
    return postPrComment(context, body);
  }

  async postReview(
    context: PrCommentContext,
    summary: string,
    comments: InlineComment[],
  ): Promise<PostReviewResult> {
    return postPrReview(context, summary, comments);
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
