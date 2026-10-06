import assert from "node:assert/strict";
import test from "node:test";

import { postPrComment, postPrReview, postPrNotice, deletePrNotice, type PrCommentContext } from "./pr-comment.js";
import type { InlineComment } from "./inline-comments.js";
import { SKIP_NOTICE_MARKER } from "./review-anchor.js";

const CTX: PrCommentContext = {
  apiBase: "https://api.test.local",
  repository: "octocat/Hello-World",
  pr: 42,
  token: "tkn",
  headSha: "abc123",
};

const COMMENTS: InlineComment[] = [
  { file: "src/a.ts", line: 10, side: "RIGHT", severity: "blocking", body: "bug" },
  { file: "src/b.ts", line: 20, side: "LEFT", severity: "warning", body: "removed check" },
];

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

/**
 * Stub globalThis.fetch with a fixed sequence of outcomes. Each entry is
 * either an HTTP response (optionally with response headers, e.g. a
 * pagination Link header) or `{ throw }` for a network-level failure. Each
 * call records its url/method/body so assertions can inspect the payload.
 * The stub is restored in t.afterEach so tests don't leak fetch state.
 */
function withFetchStub(
  responses: (
    | { status: number; ok: boolean; json?: string; headers?: Record<string, string> }
    | { throw: string }
  )[],
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
          `(only ${responses.length} response(s) stubbed). ` +
          `This usually means the fallback chain made more calls than the test expected.`,
      );
    }
    const r = responses[i];
    i += 1;
    if ("throw" in r) return Promise.reject(new TypeError(r.throw));
    return Promise.resolve(
      new Response(r.json ?? "{}", {
        status: r.status,
        statusText: r.ok ? "OK" : "ERR",
        headers: r.headers,
      }),
    );
  }) as typeof fetch;
  return fn(calls).finally(() => {
    globalThis.fetch = original;
  });
}

test("postPrReview", async (t) => {
  await t.test("posts review with inline comments on success", async () => {
    await withFetchStub([{ status: 200, ok: true }], async (calls) => {
      const outcome = await postPrReview(CTX, "summary", COMMENTS);
      assert.equal(outcome, "review");
      assert.equal(calls.length, 1);
      assert.match(calls[0].url, /\/pulls\/42\/reviews$/);
      assert.equal(calls[0].method, "POST");
      const body = calls[0].body as {
        commit_id: string;
        event: string;
        body: string;
        comments: { path: string; line: number; side: string; body: string }[];
      };
      assert.equal(body.commit_id, "abc123");
      assert.equal(body.event, "COMMENT");
      assert.equal(body.body, "summary");
      assert.equal(body.comments.length, 2);
      // Severity emoji is prefixed at render time.
      assert.equal(body.comments[0].body, "🔴 bug");
      assert.equal(body.comments[1].body, "🟡 removed check");
      // path/line/side pass through unchanged.
      assert.equal(body.comments[0].path, "src/a.ts");
      assert.equal(body.comments[0].side, "RIGHT");
    });
  });

  await t.test("prefixes body with ✅ verify emoji when status is set", async () => {
    // When the verifier ran, findings carry status="verified" and the body
    // gains a ✅ marker before the severity emoji. Absent status (skip-verify)
    // renders with no verify marker — covered by the test above.
    const verified: InlineComment[] = [
      { file: "src/a.ts", line: 10, side: "RIGHT", severity: "blocking", body: "bug", status: "verified" },
    ];
    await withFetchStub([{ status: 200, ok: true }], async (calls) => {
      await postPrReview(CTX, "summary", verified);
      const body = calls[0].body as { comments: { body: string }[] };
      assert.equal(body.comments[0].body, "✅ 🔴 bug");
    });
  });

  await t.test("falls back to summary review when inline batch rejected", async () => {
    await withFetchStub(
      [{ status: 422, ok: false }, { status: 200, ok: true }],
      async (calls) => {
        const outcome = await postPrReview(CTX, "summary", COMMENTS);
        assert.equal(outcome, "summary-review");
        assert.equal(calls.length, 2);
        // Both calls hit the reviews endpoint.
        assert.match(calls[1].url, /\/pulls\/42\/reviews$/);
        // Second attempt drops the inline batch.
        const body2 = calls[1].body as { comments: unknown[] };
        assert.equal(body2.comments.length, 0);
      },
    );
  });

  await t.test("comment fallback after review failure posts the FULL body (#62)", async () => {
    // Both review attempts rejected → issue comment. The review surface is
    // slim, but once the run degrades to a single comment surface the body
    // must be the full summary (commentFallback), never the slim digest.
    await withFetchStub(
      [
        { status: 422, ok: false },
        { status: 422, ok: false },
        { status: 200, ok: true, json: "[]" },
        { status: 200, ok: true },
      ],
      async (calls) => {
        const outcome = await postPrReview(CTX, "slim", COMMENTS, "full body");
        assert.equal(outcome, "created");
        // Stage 3 lands on the issues endpoint with the fallback body.
        assert.match(calls[3].url, /\/issues\/42\/comments$/);
        const created = calls[3].body as { body: string };
        assert.match(created.body, /full body/);
        assert.doesNotMatch(created.body, /slim/);
      },
    );
  });

  await t.test("does not re-POST when a lost response actually persisted the review", async () => {
    // Reviews API creates a new thread per POST (no commit_id dedup), so a
    // blind retry after a lost response would duplicate the review. On a
    // transient failure the code reconciles against the server first: the
    // GET finds a matching review (same commit + body) → success, no re-POST.
    const listed = JSON.stringify([{ commit_id: "abc123", body: "summary" }]);
    await withFetchStub(
      [{ throw: "fetch failed" }, { status: 200, ok: true, json: listed }],
      async (calls) => {
        const outcome = await postPrReview(CTX, "summary", COMMENTS);
        assert.equal(outcome, "review");
        assert.equal(calls.length, 2);
        assert.match(calls[1].url, /\/pulls\/42\/reviews\?per_page=100$/);
        assert.equal(calls[1].method, "GET");
      },
    );
  });

  await t.test("re-POSTs after a transient failure when no matching review exists", async () => {
    await withFetchStub(
      [
        { throw: "fetch failed" },
        { status: 200, ok: true, json: "[]" },
        { status: 200, ok: true },
      ],
      async (calls) => {
        const outcome = await postPrReview(CTX, "summary", COMMENTS);
        assert.equal(outcome, "review");
        assert.equal(calls.length, 3);
        assert.equal(calls[2].method, "POST");
      },
    );
  });

  await t.test("returns skipped when token missing", async () => {
    await withFetchStub([{ status: 200, ok: true }], async (calls) => {
      const outcome = await postPrReview({ ...CTX, token: "" }, "summary", COMMENTS);
      assert.equal(outcome, "skipped");
      assert.equal(calls.length, 0);
    });
  });

  await t.test("routes to issue-comment path when headSha missing", async () => {
    // Without headSha, postPrReview delegates to postPrComment, which lists
    // existing comments then creates. The first call must hit the issues
    // endpoint, NOT the reviews endpoint — that's the contract we're proving.
    await withFetchStub(
      [{ status: 200, ok: true }, { status: 200, ok: true }],
      async (calls) => {
        const outcome = await postPrReview({ ...CTX, headSha: "" }, "summary", COMMENTS);
        assert.match(outcome, /^(created|updated|skipped)$/);
        assert.match(calls[0].url, /\/issues\/42\/comments/);
      },
    );
  });

  await t.test("routes to issue-comment path when comments empty", async () => {
    // Empty comments array is a no-op for the Reviews API — delegate to
    // postPrComment's edit-in-place summary.
    await withFetchStub(
      [{ status: 200, ok: true }, { status: 200, ok: true }],
      async (calls) => {
        const outcome = await postPrReview(CTX, "summary", []);
        assert.match(outcome, /^(created|updated|skipped)$/);
        assert.match(calls[0].url, /\/issues\/42\/comments/);
      },
    );
  });
});

test("postPrComment", async (t) => {
  const existing = JSON.stringify([
    { id: 777, body: "<!-- pi-review-agent -->\n<!-- pi-review-agent-sha:abc123 -->\n❓ UNKNOWN\nstale fragment" },
  ]);

  await t.test("updates the same-SHA comment in place instead of creating", async () => {
    await withFetchStub(
      [
        { status: 200, ok: true, json: existing },
        { status: 200, ok: true },
      ],
      async (calls) => {
        const outcome = await postPrComment(CTX, "fresh summary");
        assert.equal(outcome, "updated");
        assert.equal(calls.length, 2);
        assert.match(calls[0].url, /\/issues\/42\/comments$/);
        assert.match(calls[1].url, /\/issues\/comments\/777$/);
        assert.equal(calls[1].method, "PATCH");
        const body = calls[1].body as { body: string };
        assert.match(body.body, /<!-- pi-review-agent-sha:abc123 -->/);
        assert.match(body.body, /fresh summary/);
      },
    );
  });

  await t.test("creates a fresh comment for a new SHA", async () => {
    await withFetchStub(
      [
        { status: 200, ok: true, json: existing },
        { status: 200, ok: true },
      ],
      async (calls) => {
        const outcome = await postPrComment({ ...CTX, headSha: "def456" }, "new sha summary");
        assert.equal(outcome, "created");
        assert.equal(calls.length, 2);
        assert.equal(calls[1].method, "POST");
        assert.match(calls[1].url, /\/issues\/42\/comments$/);
      },
    );
  });

  await t.test("retries a transient fetch failure instead of discarding the result (#59)", async () => {
    // The observed failure: one "fetch failed" on a self-hosted runner
    // skipped posting entirely, losing a finished CAN MERGE review.
    await withFetchStub(
      [{ throw: "fetch failed" }, { status: 200, ok: true }, { status: 200, ok: true }],
      async (calls) => {
        const outcome = await postPrComment(CTX, "retry me");
        assert.equal(outcome, "created");
        assert.equal(calls.length, 3);
      },
    );
  });

  await t.test("still skips after exhausting transient retries", async () => {
    await withFetchStub(
      [{ throw: "fetch failed" }, { throw: "fetch failed" }, { throw: "fetch failed" }],
      async (calls) => {
        const outcome = await postPrComment(CTX, "doomed");
        assert.equal(outcome, "skipped");
        assert.equal(calls.length, 3);
      },
    );
  });
});

test("postPrNotice / deletePrNotice (#88)", async (t) => {
  const notice = JSON.stringify([
    { id: 777, body: "<!-- pi-review-agent -->\n<!-- pi-review-agent-sha:abc123 -->\nreview" },
    { id: 42, body: `${SKIP_NOTICE_MARKER}\nolder notice` },
    { id: 99, body: "someone else's comment" },
  ]);

  await t.test("creates the notice when none exists; payload carries no anchor grammar", async () => {
    await withFetchStub(
      [
        { status: 200, ok: true, json: "[]" },
        { status: 201, ok: true },
      ],
      async (calls) => {
        const outcome = await postPrNotice(CTX, "skip body");
        assert.equal(outcome, "created");
        const body = (calls[1].body as { body: string }).body;
        assert.ok(body.startsWith(SKIP_NOTICE_MARKER + "\n"));
        assert.ok(!body.includes("<!-- pi-review-agent -->"));
        assert.ok(!body.includes("<!-- pi-review-agent-sha:"));
        assert.match(body, /skip body/);
      },
    );
  });

  await t.test("updates the newest existing notice regardless of head SHA (marker-keyed)", async () => {
    await withFetchStub(
      [
        { status: 200, ok: true, json: notice },
        { status: 200, ok: true },
      ],
      async (calls) => {
        // A DIFFERENT head SHA must still update — one standing comment,
        // never one notice per push.
        const outcome = await postPrNotice({ ...CTX, headSha: "def4560000000000000000000000000000000000" }, "refreshed");
        assert.equal(outcome, "updated");
        assert.equal(calls[1].method, "PATCH");
        assert.match(calls[1].url, /\/issues\/comments\/42$/);
        // The notice lookup pages wide (#89 dogfood): per_page=100, not the
        // 30-oldest default.
        assert.match(calls[0].url, /[?&]per_page=100/);
      },
    );
  });

  await t.test("follows the Link header to the last page where the notice lives (busy PR)", async () => {
    const lastUrl = "https://api.test.local/repos/octocat/Hello-World/issues/42/comments?per_page=100&page=7";
    await withFetchStub(
      [
        // First page: 100 older comments, none of ours, paginated.
        { status: 200, ok: true, json: "[]", headers: { link: `<${lastUrl}>; rel="last"` } },
        { status: 200, ok: true, json: JSON.stringify([{ id: 42, body: `${SKIP_NOTICE_MARKER}\nnotice` }]) },
        { status: 200, ok: true },
      ],
      async (calls) => {
        const outcome = await postPrNotice(CTX, "refreshed");
        assert.equal(outcome, "updated");
        assert.equal(calls[1].url, lastUrl);
        assert.equal(calls[2].method, "PATCH");
        assert.match(calls[2].url, /\/issues\/comments\/42$/);
      },
    );
  });

  await t.test("no token: skipped without any fetch", async () => {
    await withFetchStub([], async (calls) => {
      assert.equal(await postPrNotice({ ...CTX, token: "" }, "x"), "skipped");
      assert.equal(calls.length, 0);
    });
  });

  await t.test("deletePrNotice removes the newest notice", async () => {
    await withFetchStub(
      [
        { status: 200, ok: true, json: notice },
        { status: 200, ok: true },
      ],
      async (calls) => {
        assert.equal(await deletePrNotice(CTX), "deleted");
        assert.equal(calls[1].method, "DELETE");
        assert.match(calls[1].url, /\/issues\/comments\/42$/);
      },
    );
  });

  await t.test("deletePrNotice: 'none' when no notice exists", async () => {
    await withFetchStub([{ status: 200, ok: true, json: "[]" }], async (calls) => {
      assert.equal(await deletePrNotice(CTX), "none");
      assert.equal(calls.length, 1);
    });
  });
});
