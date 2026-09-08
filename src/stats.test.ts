import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildStatsEvent,
  resolveRunIdentity,
  statsEventLine,
  appendStatsEvent,
  shipStatsEvents,
  recordStats,
  type StatsPersonaInput,
} from "./stats.js";

function persona(overrides: Partial<StatsPersonaInput> = {}): StatsPersonaInput {
  return {
    name: "quality",
    usage: { input: 100, output: 10, cacheRead: 900, cacheWrite: 0, costTotal: 0.01 },
    resumed: false,
    ...overrides,
  };
}

const severity = { decision: "CAN MERGE", blocking: 0, warning: 1, fallback: false };

describe("buildStatsEvent", () => {
  it("sums usage and cost across personas and the coordinator", () => {
    const event = buildStatsEvent({
      platform: "github",
      repository: "owner/repo",
      pr: 7,
      runId: "42",
      attempt: 1,
      mode: "team",
      personas: [persona({ name: "quality" }), persona({ name: "security", usage: { input: 50, output: 5, cacheRead: 0, cacheWrite: 10, costTotal: 0.02 } })],
      coordinator: persona({ name: "coordinator", usage: { input: 200, output: 20, cacheRead: 0, cacheWrite: 0, costTotal: 0.03 } }),
      verdict: "CAN MERGE",
      severity,
      durationMs: 1500,
      now: new Date("2026-09-08T00:00:00Z"),
    });
    assert.equal(event.usage.input, 350);
    assert.equal(event.usage.output, 35);
    assert.equal(event.usage.cacheRead, 900);
    assert.equal(event.usage.cacheWrite, 10);
    assert.equal(event.costTotal, 0.06, "cost = personas + coordinator");
    assert.equal(event.ts, "2026-09-08T00:00:00.000Z");
    assert.equal(event.personas.length, 3, "coordinator lands in the personas array");
    assert.equal(event.personas[2].name, "coordinator");
    assert.equal(event.personas[2].cost, 0.03);
  });

  it("keeps a failed persona's error and zeroed usage, no coordinator in single mode", () => {
    const event = buildStatsEvent({
      platform: "local",
      repository: "local",
      pr: 1,
      runId: "local-abc",
      attempt: 1,
      mode: "single",
      personas: [persona({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costTotal: 0 }, error: "boom" })],
      coordinator: null,
      verdict: null,
      severity: { decision: "CANNOT MERGE", blocking: 0, warning: 0, fallback: true },
      durationMs: null,
    });
    assert.equal(event.personas[0].error, "boom");
    assert.equal(event.costTotal, 0);
    assert.equal(event.verdict, null);
    assert.equal(event.durationMs, null);
  });
});

describe("resolveRunIdentity", () => {
  it("uses CI run id and attempt when injected", () => {
    assert.deepEqual(
      resolveRunIdentity({ GITHUB_RUN_ID: "123456", GITHUB_RUN_ATTEMPT: "2" }),
      { runId: "123456", attempt: 2 },
    );
  });

  it("falls back to attempt 1 for a missing/garbage attempt", () => {
    assert.deepEqual(resolveRunIdentity({ GITHUB_RUN_ID: "123456" }), { runId: "123456", attempt: 1 });
    assert.deepEqual(
      resolveRunIdentity({ GITHUB_RUN_ID: "123456", GITHUB_RUN_ATTEMPT: "abc" }),
      { runId: "123456", attempt: 1 },
    );
  });

  it("mints a distinct local id per call when no CI env exists", () => {
    const a = resolveRunIdentity({});
    const b = resolveRunIdentity({});
    assert.match(a.runId, /^local-/);
    assert.notEqual(a.runId, b.runId);
  });
});

describe("statsEventLine / appendStatsEvent", () => {
  it("serializes one parseable JSONL line with < escaped", () => {
    const line = statsEventLine({
      ...buildStatsEvent({
        platform: "github",
        repository: "a<b/repo",
        pr: 1,
        runId: "1",
        attempt: 1,
        mode: "team",
        personas: [],
        coordinator: null,
        verdict: null,
        severity,
        durationMs: 0,
      }),
    });
    assert.ok(line.endsWith("\n"));
    assert.ok(!line.slice(0, -1).includes("\n"), "single line");
    assert.ok(!line.includes("<"), "raw < would break inline <script> embedding");
    assert.equal(JSON.parse(line).repository, "a<b/repo");
  });

  it("appends one line per event", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-stats-"));
    try {
      const file = join(dir, "stats.jsonl");
      const base = {
        platform: "github",
        repository: "owner/repo",
        pr: 1,
        runId: "1",
        attempt: 1,
        mode: "team" as const,
        personas: [],
        coordinator: null,
        verdict: null,
        severity,
        durationMs: 0,
      };
      appendStatsEvent(file, buildStatsEvent(base));
      appendStatsEvent(file, buildStatsEvent(base));
      const lines = readFileSync(file, "utf8").trim().split("\n");
      assert.equal(lines.length, 2);
      assert.equal(JSON.parse(lines[0]).schema, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("shipStatsEvents", () => {
  it("returns true on 2xx and sends bearer token when provided", async () => {
    const original = globalThis.fetch;
    let authHeader: string | undefined;
    let body = "";
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      authHeader = init?.headers && "authorization" in init.headers ? String(init.headers.authorization) : undefined;
      body = String(init?.body);
      return new Response("{}", { status: 202 });
    }) as typeof fetch;
    try {
      const event = buildStatsEvent({
        platform: "github", repository: "o/r", pr: 1, runId: "1", attempt: 1,
        mode: "team", personas: [], coordinator: null, verdict: null, severity, durationMs: 0,
      });
      assert.equal(await shipStatsEvents("http://dash/api/events", "sekrit", [event]), true);
      assert.equal(authHeader, "Bearer sekrit");
      assert.equal(JSON.parse(body).repository, "o/r");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("fail-open: non-2xx and network errors return false, never throw", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    try {
      assert.equal(await shipStatsEvents("http://dash/api/events", undefined, []), false, "empty batch short-circuits");
    } finally {
      globalThis.fetch = original;
    }
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    try {
      assert.equal(await shipStatsEvents("http://dash/api/events", undefined, [
        buildStatsEvent({
          platform: "github", repository: "o/r", pr: 1, runId: "1", attempt: 1,
          mode: "team", personas: [], coordinator: null, verdict: null, severity, durationMs: 0,
        }),
      ]), false);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("recordStats", () => {
  it("never throws: bad file path and unreachable url only warn", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("down");
    }) as typeof fetch;
    try {
      await recordStats({
        file: "Z:/definitely/not/a/dir/stats.jsonl",
        url: "http://dash.internal:8787/api/events",
        event: buildStatsEvent({
          platform: "local", repository: "local", pr: 1, runId: "local-x", attempt: 1,
          mode: "single", personas: [], coordinator: null, verdict: null, severity, durationMs: 1,
        }),
      });
      assert.ok(true, "recordStats completed without throwing");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("appends locally when the path is writable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-stats-"));
    try {
      const file = join(dir, "stats.jsonl");
      await recordStats({
        file,
        event: buildStatsEvent({
          platform: "local", repository: "local", pr: 1, runId: "local-y", attempt: 1,
          mode: "single", personas: [], coordinator: null, verdict: null, severity, durationMs: 1,
        }),
      });
      assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
