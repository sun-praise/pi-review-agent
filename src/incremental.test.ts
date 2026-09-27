import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveIncremental, type IncrementalAdapter } from "./incremental.js";
import type { PrInfo, PrContextOptions, CompareDiffOptions } from "./platforms/types.js";
import type { ReviewAnchor } from "./review-anchor.js";

const ANCHOR_SHA = "0123456789abcdef0123456789abcdef01234567";
const HEAD_SHA = "fedcba9876543210fedcba9876543210fedcba98";
const DELTA = "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new";
const FULL_DIFF = "diff --git a/src/a.ts b/src/a.ts\n@@ -1,9 +1,9 @@";

interface FakeAdapterOptions {
  prInfo?: PrInfo | null;
  anchor?: ReviewAnchor | null;
  delta?: string | null;
  compare?: string | null;
}

/** Adapter stub recording the calls it received. */
function fakeAdapter(opts: FakeAdapterOptions = {}): IncrementalAdapter & {
  anchorCalls: PrContextOptions[];
  compareCalls: CompareDiffOptions[];
} {
  const anchorCalls: PrContextOptions[] = [];
  const compareCalls: CompareDiffOptions[] = [];
  return {
    anchorCalls,
    compareCalls,
    resolvePrFromEnv: () =>
      opts.prInfo === undefined
        ? ({
            pr: 7,
            repository: "owner/repo",
            apiBase: "https://api.github.com",
            token: "t0",
            headSha: HEAD_SHA,
          } satisfies PrInfo)
        : opts.prInfo,
    getLastReviewAnchor: async (options) => {
      anchorCalls.push(options);
      return (
        opts.anchor === undefined
          ? { sha: ANCHOR_SHA, body: "previous synthesis" }
          : opts.anchor
      );
    },
    fetchCompareDiff: async (options) => {
      compareCalls.push(options);
      return opts.compare ?? null;
    },
  };
}

/** Delta computation stub: returns the configured value (null = failure). */
function fakeCompute(result: string | null) {
  const calls: string[][] = [];
  const fn = async (prev: string, head: string) => {
    calls.push([prev, head]);
    return result;
  };
  return { fn: fn as (prev: string, head: string, cwd: string, deps?: unknown) => Promise<string | null>, calls };
}

const QUERY = { forceFull: false, pr: 7, cwd: "/repo" };

describe("resolveIncremental — full-review fallbacks", () => {
  it("force-full wins before any network or git work", async () => {
    const adapter = fakeAdapter();
    const out = await resolveIncremental({ ...QUERY, forceFull: true }, adapter, FULL_DIFF, {}, {
      computeDelta: fakeCompute(DELTA).fn,
    });
    assert.deepEqual(out, { mode: "full", reason: "force-full set" });
    assert.equal(adapter.anchorCalls.length, 0);
  });

  it("no platform identity → full", async () => {
    const out = await resolveIncremental(QUERY, fakeAdapter({ prInfo: null }), FULL_DIFF, {}, {
      computeDelta: fakeCompute(DELTA).fn,
    });
    assert.equal(out.mode, "full");
  });

  it("no anchor (first review) → full", async () => {
    const out = await resolveIncremental(QUERY, fakeAdapter({ anchor: null }), FULL_DIFF, {}, {
      computeDelta: fakeCompute(DELTA).fn,
    });
    assert.equal(out.mode, "full");
    assert.match(out.mode === "full" ? out.reason : "", /no prior review anchor/);
  });

  it("anchor already at head (same-SHA re-run) → full", async () => {
    const out = await resolveIncremental(
      QUERY,
      fakeAdapter({ anchor: { sha: HEAD_SHA, body: "x" } }),
      FULL_DIFF,
      {},
      { computeDelta: fakeCompute(DELTA).fn },
    );
    assert.equal(out.mode, "full");
    assert.match(out.mode === "full" ? out.reason : "", /already at head/);
  });

  it("delta unavailable (non-ancestor pair included) → full", async () => {
    const out = await resolveIncremental(QUERY, fakeAdapter(), FULL_DIFF, {}, {
      computeDelta: fakeCompute(null).fn,
    });
    assert.equal(out.mode, "full");
    assert.match(out.mode === "full" ? out.reason : "", /delta since/);
  });

  it("EMPTY delta → full review, not an empty-diff run (regression: loadDiff crash)", async () => {
    const out = await resolveIncremental(QUERY, fakeAdapter(), FULL_DIFF, {}, {
      computeDelta: fakeCompute("").fn,
    });
    // The empty string must never become the run's diff source: loadDiff
    // treats a falsy diffInline as "no source" and throws, failing the run.
    assert.equal(out.mode, "full");
    assert.match(out.mode === "full" ? out.reason : "", /delta is empty/);
  });

  it("full diff unavailable → full review (regression: verifier baseline loss)", async () => {
    const out = await resolveIncremental(QUERY, fakeAdapter(), undefined, {}, {
      computeDelta: fakeCompute(DELTA).fn,
    });
    assert.equal(out.mode, "full");
    assert.match(out.mode === "full" ? out.reason : "", /full diff unavailable/);
  });
});

describe("resolveIncremental — delta mode", () => {
  it("returns the delta with anchor body and the full diff as verifier baseline", async () => {
    const compute = fakeCompute(DELTA);
    const out = await resolveIncremental(QUERY, fakeAdapter(), FULL_DIFF, {}, {
      computeDelta: compute.fn,
    });
    assert.deepEqual(out, {
      mode: "delta",
      since: ANCHOR_SHA,
      previousReview: "previous synthesis",
      delta: DELTA,
      fullDiff: FULL_DIFF,
    });
    // Computed from the anchor to the CURRENT head.
    assert.deepEqual(compute.calls, [[ANCHOR_SHA, HEAD_SHA]]);
  });

  it("threads the compare fallback through the adapter", async () => {
    const compute = async (
      _prev: string,
      _head: string,
      _cwd: string,
      deps?: { fetchCompare?: (b: string, h: string) => Promise<string | null> },
    ) => deps?.fetchCompare?.(ANCHOR_SHA, HEAD_SHA) ?? DELTA;
    const adapter = fakeAdapter({ compare: "compare-delta" });
    const out = await resolveIncremental(QUERY, adapter, FULL_DIFF, {}, { computeDelta: compute });
    assert.equal(out.mode, "delta");
    assert.equal(out.mode === "delta" ? out.delta : "", "compare-delta");
    assert.equal(adapter.compareCalls.length, 1);
    assert.equal(adapter.compareCalls[0]?.base, ANCHOR_SHA);
    assert.equal(adapter.compareCalls[0]?.head, HEAD_SHA);
  });
});
