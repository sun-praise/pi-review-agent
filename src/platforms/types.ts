/**
 * Platform adapter interface for abstracting Git platform operations.
 * Supports GitHub and Gitea implementations.
 */

export type Platform = "github" | "gitea";

export interface PrContextOptions {
  /** API base URL, e.g. https://api.github.com or https://gitea.example.com/api/v1 */
  apiBase: string;
  /** Repository identifier, e.g. "owner/repo" */
  repository: string;
  /** Pull request number */
  pr: number;
  /** Authentication token */
  token: string;
}

export interface PrCommentContext {
  /** API base URL */
  apiBase: string;
  /** Repository identifier */
  repository: string;
  /** Pull request number */
  pr: number;
  /** Authentication token */
  token: string;
  /** PR head commit SHA for idempotent updates */
  headSha: string;
}

export interface PrInfo {
  /** Pull request number */
  pr: number;
  /** Repository identifier */
  repository: string;
  /** API base URL */
  apiBase: string;
  /** Authentication token */
  token: string;
  /** Head commit SHA for idempotent comment updates */
  headSha: string;
}

export interface InlineComment {
  /** Repository-relative file path */
  file: string;
  /** 1-based line number */
  line: number;
  /** LEFT = removed line, RIGHT = added/context line */
  side: "LEFT" | "RIGHT";
  /** Severity level */
  severity: "blocking" | "warning" | "suggestion";
  /** Markdown body */
  body: string;
  /** Verifier status. Absent when verification was skipped (backward compat).
   *  Demoted comments never reach the adapter layer (filtered upstream). */
  status?: "verified" | "demoted";
}

export type PostReviewResult = "review" | "summary-review" | "created" | "updated" | "skipped";

export interface PlatformAdapter {
  /**
   * Fetch PR context (title, body, comments, reviews, changed files)
   * and format it as reviewer context string.
   * Returns empty string on failure (best-effort).
   */
  fetchPrContext(options: PrContextOptions): Promise<string>;

  /**
   * Post or update a PR comment.
   * Returns the action taken, or "skipped" on failure.
   */
  postComment(context: PrCommentContext, body: string): Promise<"created" | "updated" | "skipped">;

  /**
   * Post a PR review with optional inline comments.
   * Falls back to summary review or issue comment if inline comments fail.
   * `commentFallback` overrides the body used when the review layer degrades
   * to an issue comment (#62: the review body is slim, but a degraded run has
   * only the one comment surface, so it must carry the full summary).
   * Returns the action taken, or "skipped" on failure.
   */
  postReview(
    context: PrCommentContext,
    summary: string,
    comments: InlineComment[],
    commentFallback?: string,
  ): Promise<PostReviewResult>;

  /**
   * Resolve PR info from environment variables.
   * Returns null if platform-specific env vars are not set.
   */
  resolvePrFromEnv(env: NodeJS.ProcessEnv): PrInfo | null;
}

export interface AdapterFactory {
  create(): PlatformAdapter;
}
