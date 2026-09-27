import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeDeltaDiff, type GitResult, type GitRunner } from "./delta-diff.js";

const PREV = "0123456789abcdef0123456789abcdef01234567";
const HEAD = "fedcba9876543210fedcba9876543210fedcba98";
const DELTA = "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new";

function ok(stdout = ""): GitResult {
  return { code: 0, stdout, stderr: "" };
}

function fail(stderr = "boom"): GitResult {
  return { code: 128, stdout: "", stderr };
}

interface ScriptedGit {
  runner: GitRunner;
  calls: string[][];
}

/** Fake runner driven by a first-token dispatch table, recording every call. */
function scriptedGit(
  handlers: Record<string, (args: string[]) => GitResult | Promise<GitResult>>,
): ScriptedGit {
  const calls: string[][] = [];
  const runner: GitRunner = async (args) => {
    calls.push(args);
    const handler = handlers[args[0]];
    if (!handler) return fail(`no handler for ${args[0]}`);
    return handler(args);
  };
  return { runner, calls };
}

function catFileOk(args: string[]): GitResult {
  // args: ["cat-file", "-e", "<sha>^{commit}"]
  return args[2]?.startsWith(PREV) || args[2]?.startsWith(HEAD) ? ok() : fail("unknown sha");
}

describe("computeDeltaDiff — validation", () => {
  it("rejects non-sha inputs before touching git", async () => {
    const { runner, calls } = scriptedGit({});
    assert.deepEqual(await computeDeltaDiff("not-a-sha", HEAD, "/repo", { runGit: runner }), { error: "unavailable" });
    assert.deepEqual(await computeDeltaDiff(PREV, "abc123", "/repo", { runGit: runner }), { error: "unavailable" });
    assert.equal(calls.length, 0);
  });
});

describe("computeDeltaDiff — git path", () => {
  it("diffs straight away when both commits are local", async () => {
    const { runner, calls } = scriptedGit({
      "rev-parse": () => ok(".git"),
      "cat-file": catFileOk,
      "merge-base": () => ok(),
      diff: () => ok(DELTA),
    });
    assert.deepEqual(await computeDeltaDiff(PREV, HEAD, "/repo", { runGit: runner }), { diff: DELTA });
    assert.deepEqual(calls[calls.length - 1], [
      "diff",
      "--no-color",
      "--no-textconv",
      "--no-ext-diff",
      PREV,
      HEAD,
    ]);
    assert.ok(!calls.some((c) => c[0] === "fetch"), "no fetch when objects are local");
  });

  it("fetches missing SHAs from origin, then diffs", async () => {
    let prevLocal = false;
    const { runner, calls } = scriptedGit({
      "rev-parse": () => ok(".git"),
      "cat-file": (args) => {
        if (args[2]?.startsWith(PREV)) return prevLocal ? ok() : fail("missing");
        return ok();
      },
      fetch: () => {
        prevLocal = true;
        return ok();
      },
      "merge-base": () => ok(),
      diff: () => ok(DELTA),
    });
    assert.deepEqual(await computeDeltaDiff(PREV, HEAD, "/repo", { runGit: runner }), { diff: DELTA });
    assert.deepEqual(
      calls.find((c) => c[0] === "fetch"),
      ["fetch", "--no-tags", "--filter=blob:none", "origin", PREV, HEAD],
    );
  });

  it("an empty diff is a valid delta (returns \"\"), not a failure", async () => {
    const { runner } = scriptedGit({
      "rev-parse": () => ok(".git"),
      "cat-file": catFileOk,
      "merge-base": () => ok(),
      diff: () => ok(""),
    });
    assert.deepEqual(await computeDeltaDiff(PREV, HEAD, "/repo", { runGit: runner }), { diff: "" });
  });

  it("a non-repo cwd goes to the compare fallback", async () => {
    const { runner } = scriptedGit({ "rev-parse": () => fail("not a git repository") });
    const out = await computeDeltaDiff(PREV, HEAD, "/repo", {
      runGit: runner,
      fetchCompare: async () => "compare-delta",
    });
    assert.deepEqual(out, { diff: "compare-delta" });
  });

  it("a failed fetch, a still-missing object, and a failed diff all fall back", async () => {
    const cases: Record<string, ReturnType<typeof scriptedGit>> = {
      "fetch fails": scriptedGit({
        "rev-parse": () => ok(".git"),
        "cat-file": () => fail("missing"),
        fetch: () => fail("remote error"),
      }),
      "object still missing after fetch": scriptedGit({
        "rev-parse": () => ok(".git"),
        "cat-file": () => fail("missing"),
        fetch: () => ok(),
      }),
      "diff exits non-zero": scriptedGit({
        "rev-parse": () => ok(".git"),
        "cat-file": catFileOk,
        "merge-base": () => ok(),
        diff: () => fail("fatal: bad object"),
      }),
    };
    for (const [label, { runner }] of Object.entries(cases)) {
      const viaGit = await computeDeltaDiff(PREV, HEAD, "/repo", { runGit: runner });
      assert.deepEqual(viaGit, { error: "unavailable" }, label);
      const viaCompare = await computeDeltaDiff(PREV, HEAD, "/repo", {
        runGit: runner,
        fetchCompare: async () => "compare-delta",
      });
      assert.deepEqual(viaCompare, { diff: "compare-delta" }, label);
    }
  });
});

describe("computeDeltaDiff — partial-clone fetch fallback", () => {
  it("falls back to a plain fetch when --filter=blob:none is rejected", async () => {
    let prevLocal = false;
    const fetches: string[][] = [];
    const { runner } = scriptedGit({
      "rev-parse": () => ok(".git"),
      "cat-file": (args) => {
        if (args[2]?.startsWith(PREV)) return prevLocal ? ok() : fail("missing");
        return ok();
      },
      fetch: (args) => {
        fetches.push(args);
        if (args.includes("--filter=blob:none")) return fail("filter not supported");
        prevLocal = true;
        return ok();
      },
      "merge-base": () => ok(),
      diff: () => ok(DELTA),
    });
    const out = await computeDeltaDiff(PREV, HEAD, "/repo", { runGit: runner });
    assert.deepEqual(out, { diff: DELTA });
    assert.equal(fetches.length, 2, "blob-less attempt, then plain fetch");
  });
});

describe("computeDeltaDiff — no fallback configured", () => {
  it("returns null when git fails and no compare API is given", async () => {
    const { runner } = scriptedGit({ "rev-parse": () => fail("no repo") });
    assert.deepEqual(await computeDeltaDiff(PREV, HEAD, "/repo", { runGit: runner }), { error: "unavailable" });
  });
});

describe("computeDeltaDiff — ancestry gate", () => {
  it("a non-ancestor pair (rebase/force-push) returns null WITHOUT the compare fallback", async () => {
    const { runner, calls } = scriptedGit({
      "rev-parse": () => ok(".git"),
      "cat-file": catFileOk,
      // exit 1 = prev is NOT an ancestor of head
      "merge-base": () => ({ code: 1, stdout: "", stderr: "" }),
      diff: () => ok(DELTA),
    });
    let compareCalls = 0;
    const out = await computeDeltaDiff(PREV, HEAD, "/repo", {
      runGit: runner,
      fetchCompare: async () => {
        compareCalls += 1;
        return "compare-delta";
      },
    });
    assert.deepEqual(out, { error: "non-ancestor" });
    assert.equal(compareCalls, 0, "three-dot compare would silently miss reverts — must not run");
    assert.ok(!calls.some((c) => c[0] === "diff"), "no diff computed for a non-ancestor pair");
  });

  it("a git error during the ancestry check still falls back to compare", async () => {
    const { runner } = scriptedGit({
      "rev-parse": () => ok(".git"),
      "cat-file": catFileOk,
      // exit >1 = git error, not a definite non-ancestor verdict
      "merge-base": () => ({ code: 128, stdout: "", stderr: "fatal" }),
    });
    const out = await computeDeltaDiff(PREV, HEAD, "/repo", {
      runGit: runner,
      fetchCompare: async () => "compare-delta",
    });
    assert.deepEqual(out, { diff: "compare-delta" });
  });
});
