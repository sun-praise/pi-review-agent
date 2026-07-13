import assert from "node:assert/strict";
import test from "node:test";

import { postPrReview, type PrCommentContext } from "./pr-comment.js";
import type { InlineComment } from "./inline-comments.js";

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
 * Stub globalThis.fetch with a fixed sequence of responses. Each call records
 * its url/method/body so assertions can inspect the Reviews API payload. The
 * stub is restored in t.afterEach so tests don't leak fetch state.
 */
function withFetchStub(
  responses: { status: number; ok: boolean }[],
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
    return Promise.resolve(
      new Response("{}", { status: r.status, statusText: r.ok ? "OK" : "ERR" }),
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
