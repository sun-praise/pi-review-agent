/**
 * Skip-notice tests (#88): the standing comment that makes a
 * max-reviews-per-pr skip visible in the PR conversation.
 *
 * Two invariants beyond routing:
 *  1. The posted payload NEVER carries the anchor grammar (SELF_MARKER /
 *     sha fingerprint) — latestReviewAnchor would otherwise parse a skipped
 *     commit as reviewed and steer the next incremental delta past
 *     unreviewed changes.
 *  2. The notice is marker-keyed, not SHA-keyed: an existing notice is
 *     PATCHed in place (one standing comment across pushes), never
 *     duplicated per head SHA.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { buildSkipNoticeBody, postSkipNoticeFromEnv, clearSkipNoticeFromEnv } from "./skip-notice.js";
import { SKIP_NOTICE_MARKER, SELF_MARKER, SHA_LINE_PREFIX } from "./review-anchor.js";

const HEAD_SHA = "9a86d5c0123456789abcdef0123456789abcdef01";

const GH_ENV: NodeJS.ProcessEnv = {
  GITHUB_REPOSITORY: "octocat/Hello-World",
  GITHUB_TOKEN: "tkn",
  GITHUB_REF: "refs/pull/7/merge",
  GITHUB_API_URL: "https://api.test.local",
  PI_REVIEW_HEAD_SHA: HEAD_SHA,
};

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

/** Same stub shape as pr-comment.test.ts: fixed response sequence, every
 * call recorded, extra calls fail loudly so the routing is pinned exactly. */
function withFetchStub(
  responses: ({ status: number; ok: boolean; json?: string } | { throw: string })[],
  fn: (calls: RecordedCall[]) => Promise<void>,
): Promise<void> {
  const calls: RecordedCall[] = [];
  const original = globalThis.fetch;
  let i = 0;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    calls.push({
      url: u,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body as string) : null,
    });
    if (i >= responses.length) {
      throw new Error(
        `withFetchStub: unexpected extra fetch call #${i + 1} to ${u} ` +
          `(only ${responses.length} response(s) stubbed).`,
      );
    }
    const r = responses[i];
    i += 1;
    if ("throw" in r) return Promise.reject(new TypeError(r.throw));
    return Promise.resolve(
      new Response(r.json ?? "{}", { status: r.status, statusText: r.ok ? "OK" : "ERR" }),
    );
  }) as typeof fetch;
  return fn(calls).finally(() => {
    globalThis.fetch = original;
  });
}

const FACTS = { completed: 5, limit: 5, headSha: HEAD_SHA, language: "en" };

test("buildSkipNoticeBody", async (t) => {
  await t.test("en: states completed/limit, the skipped sha, and the resume path", () => {
    const body = buildSkipNoticeBody(FACTS);
    assert.match(body, /5 of 5/);
    assert.match(body, /max-reviews-per-pr: 5/);
    assert.match(body, /9a86d5c0/);
    assert.match(body, /NOT reviewed/i);
    assert.match(body, /review-count\.json/);
  });

  await t.test("zh (default language): same facts in Chinese", () => {
    const body = buildSkipNoticeBody({ ...FACTS, language: "zh" });
    assert.match(body, /5 \/ 5/);
    assert.match(body, /未经评审/);
    assert.match(body, /9a86d5c0/);
  });

  await t.test("no headSha: degrades to 'this push' wording, no backtick gap", () => {
    const en = buildSkipNoticeBody({ ...FACTS, headSha: undefined });
    assert.match(en, /this push was/);
    const zh = buildSkipNoticeBody({ ...FACTS, headSha: undefined, language: "zh" });
    assert.match(zh, /本次推送 被跳过评审/);
  });

  await t.test("never carries the anchor grammar", () => {
    for (const language of ["en", "zh"]) {
      const body = buildSkipNoticeBody({ ...FACTS, language });
      assert.ok(!body.includes(SELF_MARKER));
      assert.ok(!body.includes(SHA_LINE_PREFIX));
    }
  });
});

test("postSkipNoticeFromEnv", async (t) => {
  await t.test("no platform env: returns skipped without any fetch", async () => {
    await withFetchStub([], async (calls) => {
      const outcome = await postSkipNoticeFromEnv({}, { ...FACTS, platform: undefined, pr: 0 });
      assert.equal(outcome, "skipped");
      assert.equal(calls.length, 0);
    });
  });

  await t.test("first skip: lists, then creates ONE notice comment", async () => {
    await withFetchStub(
      [
        { status: 200, ok: true, json: "[]" },
        { status: 201, ok: true },
      ],
      async (calls) => {
        const outcome = await postSkipNoticeFromEnv(GH_ENV, { ...FACTS, pr: 0 });
        assert.equal(outcome, "created");
        assert.equal(calls[0].method, "GET");
        assert.ok(
          calls[0].url.startsWith("https://api.test.local/repos/octocat/Hello-World/issues/7/comments"),
          `unexpected list url: ${calls[0].url}`,
        );
        assert.match(calls[0].url, /[?&]per_page=100/);
        assert.equal(calls[1].method, "POST");
        const body = (calls[1].body as { body: string }).body;
        assert.ok(body.startsWith(SKIP_NOTICE_MARKER + "\n"));
        assert.ok(!body.includes(SELF_MARKER));
        assert.ok(!body.includes(SHA_LINE_PREFIX));
      },
    );
  });

  await t.test("later skips: PATCH the existing notice in place (marker-keyed, not per SHA)", async () => {
    const existing = JSON.stringify([
      { id: 11, body: "someone else's comment" },
      { id: 42, body: `${SKIP_NOTICE_MARKER}\nolder notice` },
    ]);
    await withFetchStub(
      [
        { status: 200, ok: true, json: existing },
        { status: 200, ok: true },
      ],
      async (calls) => {
        const outcome = await postSkipNoticeFromEnv(GH_ENV, { ...FACTS, pr: 0 });
        assert.equal(outcome, "updated");
        assert.equal(calls[1].method, "PATCH");
        assert.ok(calls[1].url.endsWith("/repos/octocat/Hello-World/issues/comments/42"));
      },
    );
  });

  await t.test("opts.pr wins over the env-parsed PR number", async () => {
    await withFetchStub(
      [
        { status: 200, ok: true, json: "[]" },
        { status: 201, ok: true },
      ],
      async (calls) => {
        const outcome = await postSkipNoticeFromEnv(GH_ENV, { ...FACTS, pr: 9 });
        assert.equal(outcome, "created");
        assert.ok(calls[0].url.includes("/repos/octocat/Hello-World/issues/9/comments"));
      },
    );
  });

  await t.test("API failure degrades to skipped (fail-open)", async () => {
    // 403 is permanent — no retry backoff, so exactly one stubbed response.
    await withFetchStub([{ status: 403, ok: false }], async () => {
      const outcome = await postSkipNoticeFromEnv(GH_ENV, { ...FACTS, pr: 0 });
      assert.equal(outcome, "skipped");
    });
  });
});

test("clearSkipNoticeFromEnv", async (t) => {
  await t.test("deletes the notice when one exists", async () => {
    const existing = JSON.stringify([{ id: 42, body: `${SKIP_NOTICE_MARKER}\nstale` }]);
    await withFetchStub(
      [
        { status: 200, ok: true, json: existing },
        { status: 200, ok: true },
      ],
      async (calls) => {
        const outcome = await clearSkipNoticeFromEnv(GH_ENV, { pr: 0 });
        assert.equal(outcome, "deleted");
        assert.equal(calls[1].method, "DELETE");
        assert.ok(calls[1].url.endsWith("/repos/octocat/Hello-World/issues/comments/42"));
      },
    );
  });

  await t.test("no notice: 'none', single GET, no write call", async () => {
    await withFetchStub([{ status: 200, ok: true, json: "[]" }], async (calls) => {
      const outcome = await clearSkipNoticeFromEnv(GH_ENV, { pr: 0 });
      assert.equal(outcome, "none");
      assert.equal(calls.length, 1);
    });
  });

  await t.test("no platform env: 'none' without any fetch", async () => {
    await withFetchStub([], async (calls) => {
      const outcome = await clearSkipNoticeFromEnv({}, { pr: 0 });
      assert.equal(outcome, "none");
      assert.equal(calls.length, 0);
    });
  });
});
