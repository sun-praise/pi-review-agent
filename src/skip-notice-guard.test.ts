/**
 * Defensive guard for postSkipNoticeFromEnv (#89 dogfood, warning): the
 * adapters' postNotice/deleteNotice carry a "Never throws" contract, but a
 * skipped run must stay green even if an adapter ever violates it. Injects
 * an adapter that throws and pins that both entry points downgrade to
 * "skipped" instead of bubbling into main()'s exit-1 path.
 *
 * Separate file because mock.module() replaces the module registry entry
 * from the moment it runs — skip-notice.test.ts's static imports must keep
 * the real platforms/index.js, so the mocked variant lives here and loads
 * the module under test dynamically, after the mock is installed (same
 * pattern as orchestrate-modelid.test.ts).
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";

mock.module("./platforms/index.js", {
  namedExports: {
    createAdapterFromEnv: async () => ({
      adapter: {
        resolvePrFromEnv: () => ({
          pr: 7,
          repository: "octocat/Hello-World",
          apiBase: "https://api.test.local",
          token: "tkn",
          headSha: "abc123",
        }),
        postNotice: () => {
          throw new Error("adapter contract violated");
        },
        deleteNotice: () => {
          throw new Error("adapter contract violated");
        },
      },
    }),
  },
});

const { postSkipNoticeFromEnv, clearSkipNoticeFromEnv } = await import("./skip-notice.js");

const ENV: NodeJS.ProcessEnv = {
  GITHUB_REPOSITORY: "octocat/Hello-World",
  GITHUB_TOKEN: "tkn",
  GITHUB_REF: "refs/pull/7/merge",
};

test("a throwing adapter degrades to skipped instead of failing the run", async (t) => {
  await t.test("postSkipNoticeFromEnv", async () => {
    const outcome = await postSkipNoticeFromEnv(ENV, {
      pr: 7,
      completed: 5,
      limit: 5,
      language: "en",
    });
    assert.equal(outcome, "skipped");
  });

  await t.test("clearSkipNoticeFromEnv", async () => {
    const outcome = await clearSkipNoticeFromEnv(ENV, { pr: 7 });
    assert.equal(outcome, "skipped");
  });
});
