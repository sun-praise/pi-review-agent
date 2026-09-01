import assert from "node:assert/strict";
import test from "node:test";

import { withTransientRetry } from "./retry.js";

test("withTransientRetry", async (t) => {
  await t.test("returns the first success without retrying", async () => {
    let calls = 0;
    const value = await withTransientRetry(
      async () => {
        calls++;
        return "ok";
      },
      { label: "test", attempts: 3, baseMs: 1 },
    );
    assert.equal(value, "ok");
    assert.equal(calls, 1);
  });

  await t.test("retries a transient failure until success", async () => {
    let calls = 0;
    const value = await withTransientRetry(
      async () => {
        calls++;
        if (calls < 3) throw new TypeError("fetch failed");
        return 42;
      },
      { label: "test", attempts: 3, baseMs: 1 },
    );
    assert.equal(value, 42);
    assert.equal(calls, 3);
  });

  await t.test("retries transient HTTP errors (5xx / 429)", async () => {
    let calls = 0;
    await withTransientRetry(
      async () => {
        calls++;
        if (calls === 1) throw new Error("GitHub API 502 Bad Gateway: upstream");
        if (calls === 2) throw new Error("GitHub API 429 Too Many Requests");
        return "done";
      },
      { label: "test", attempts: 3, baseMs: 1 },
    );
    assert.equal(calls, 3);
  });

  await t.test("rethrows a permanent error immediately (4xx)", async () => {
    let calls = 0;
    await assert.rejects(
      withTransientRetry(
        async () => {
          calls++;
          throw new Error("GitHub API 422 Unprocessable Entity: validation failed");
        },
        { label: "test", attempts: 3, baseMs: 1 },
      ),
      /422/,
    );
    assert.equal(calls, 1);
  });

  await t.test("throws the last error after exhausting attempts", async () => {
    let calls = 0;
    await assert.rejects(
      withTransientRetry(
        async () => {
          calls++;
          throw new TypeError("fetch failed");
        },
        { label: "test", attempts: 3, baseMs: 1 },
      ),
      /fetch failed/,
    );
    assert.equal(calls, 3);
  });
});
