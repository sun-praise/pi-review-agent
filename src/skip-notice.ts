/**
 * The standing skip notice (#88): when `max-reviews-per-pr` stops reviewing
 * a PR, the run stays green — indistinguishable in the PR UI from a
 * reviewed-clean pass, and the Checks-log `::warning::` annotation is
 * something PR authors demonstrably do not open. The notice is ONE
 * marker-keyed PR comment that says "the latest push was NOT reviewed" in
 * the conversation the author actually reads, refreshed in place on every
 * skipped push (never one comment per push) and deleted by the next
 * dispatching round (index.ts calls clearSkipNoticeFromEnv next to
 * bumpReviewCount) so it cannot go stale in the opposite direction.
 *
 * Posting is fail-open like every comment path: a missing token, an
 * undetectable platform, or an API error downgrades to a stderr note and
 * never fails the (already green) run.
 */
import type { PlatformAdapter, PrCommentContext } from "./platforms/types.js";
import { createAdapterFromEnv } from "./platforms/index.js";

export interface SkipNoticeFacts {
  /** Review rounds already recorded for this PR. */
  completed: number;
  /** The configured max-reviews-per-pr. */
  limit: number;
  /** Head SHA of the skipped push, when known (PI_REVIEW_HEAD_SHA). */
  headSha?: string;
  /** Review-prose language ("zh" default) — the notice follows it. */
  language: string;
}

/**
 * Render the notice body (pure). The poster prepends SKIP_NOTICE_MARKER;
 * the body itself must never carry the anchor grammar (SELF_MARKER / sha
 * fingerprint) or latestReviewAnchor would treat a skipped commit as
 * reviewed — skip-notice.test.ts pins that invariant.
 */
export function buildSkipNoticeBody(facts: SkipNoticeFacts): string {
  const zh = facts.language.toLowerCase().startsWith("zh");
  const where =
    facts.headSha ? `\`${facts.headSha.slice(0, 8)}\`` : zh ? "本次推送" : "this push";
  if (zh) {
    return (
      "⏸️ 评审上限已到 — 本次推送未经评审\n\n" +
      `> 此 PR 已记录 **${facts.completed} / ${facts.limit}** 轮评审` +
      `（\`max-reviews-per-pr: ${facts.limit}\`），${where} 被跳过评审：` +
      "绿色通过只代表“未评审”，不代表“评审通过”。在预算调整前，后续推送同样会被跳过。\n" +
      ">\n" +
      "> 恢复评审：调高 `max-reviews-per-pr`，或删除会话缓存中的 " +
      "`<sessions-root>/<pr>/review-count.json` 重置计数。恢复评审后本公告会被自动删除。"
    );
  }
  return (
    "⏸️ Review limit reached — this push was NOT reviewed\n\n" +
    `> **${facts.completed} of ${facts.limit}** review rounds for this PR are ` +
    `already recorded (\`max-reviews-per-pr: ${facts.limit}\`), so ${where} was ` +
    'not reviewed: the green check means "not reviewed", not "approved". Every ' +
    "later push skips too, until the budget changes.\n" +
    ">\n" +
    "> To resume reviews: raise `max-reviews-per-pr`, or reset the counter by " +
    "deleting `<sessions-root>/<pr>/review-count.json` from this PR's session " +
    "cache. This notice is removed automatically once a new round runs."
  );
}

interface NoticeOptions {
  /** Platform override ("github" | "gitea"); auto-detected when unset. */
  platform?: string;
  /** Canonical PR number (--pr / PI_REVIEW_PR). Wins over the env-parsed one
   * when positive; 0 falls back to what the platform env resolves. */
  pr: number;
}

/** Resolve the adapter + posting context from env. Null (callers degrade to
 * a stderr note) when no platform is detectable or the event isn't a PR —
 * e.g. local CLI runs, or a push event with no PR to comment on. */
async function resolveNoticeContext(
  env: NodeJS.ProcessEnv,
  opts: NoticeOptions,
): Promise<{ adapter: PlatformAdapter; ctx: PrCommentContext } | null> {
  let adapter: PlatformAdapter;
  try {
    adapter = (await createAdapterFromEnv(env, opts.platform)).adapter;
  } catch {
    return null;
  }
  const info = adapter.resolvePrFromEnv(env);
  if (info === null) return null;
  return {
    adapter,
    ctx: {
      apiBase: info.apiBase,
      repository: info.repository,
      pr: opts.pr > 0 ? opts.pr : info.pr,
      token: info.token,
      headSha: info.headSha,
    },
  };
}

/** Post or refresh the standing skip notice. Never throws. */
export async function postSkipNoticeFromEnv(
  env: NodeJS.ProcessEnv,
  opts: NoticeOptions & SkipNoticeFacts,
): Promise<"created" | "updated" | "skipped"> {
  const resolved = await resolveNoticeContext(env, opts);
  if (resolved === null) {
    process.stderr.write("skip notice: no platform/PR context; not posted\n");
    return "skipped";
  }
  const facts: SkipNoticeFacts = {
    completed: opts.completed,
    limit: opts.limit,
    headSha: resolved.ctx.headSha || opts.headSha,
    language: opts.language,
  };
  const outcome = await resolved.adapter.postNotice(resolved.ctx, buildSkipNoticeBody(facts));
  process.stderr.write(`skip notice: ${outcome}\n`);
  return outcome;
}

/** Delete the standing skip notice once a round dispatches again, so it
 * cannot keep claiming pushes are unreviewed after the budget was raised or
 * the counter reset. Silent on the everyday "none" outcome (a notice-free
 * PR must not grow a log line per run); never throws. */
export async function clearSkipNoticeFromEnv(
  env: NodeJS.ProcessEnv,
  opts: NoticeOptions,
): Promise<"deleted" | "none" | "skipped"> {
  const resolved = await resolveNoticeContext(env, opts);
  if (resolved === null) return "none";
  try {
    const outcome = await resolved.adapter.deleteNotice(resolved.ctx);
    if (outcome === "deleted") {
      process.stderr.write("skip notice: stale notice deleted (reviews resumed)\n");
    } else if (outcome === "skipped") {
      process.stderr.write("skip notice: deletion failed; the notice may be stale\n");
    }
    return outcome;
  } catch (err: unknown) {
    process.stderr.write(
      `skip notice: deletion failed (${err instanceof Error ? err.message : String(err)}); the notice may be stale\n`,
    );
    return "skipped";
  }
}
