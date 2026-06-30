import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizePrContext, formatPrContext, type PrContextData } from "./github-context.js";

// Minimal valid REST shapes; nulls exercise the defensive coercion paths.
const restPr = {
  title: "Add login cache",
  body: "Fixes #42. Cuts auth latency.",
  user: { login: "alice" },
  created_at: "2026-06-28T10:00:00Z",
  base: { ref: "main" },
  head: { ref: "feat/login" },
};

const emptyData: PrContextData = {
  title: "",
  body: "",
  author: "",
  createdAt: "",
  baseRef: "",
  headRef: "",
  files: [],
  comments: [],
  reviews: [],
  reviewComments: [],
};

describe("normalizePrContext", () => {
  it("maps fields and handles nulls", () => {
    const d = normalizePrContext(
      { ...restPr, user: null, base: null, head: null, created_at: null },
      [],
      [],
      [],
      [],
    );
    assert.equal(d.author, "unknown");
    assert.equal(d.baseRef, "");
    assert.equal(d.headRef, "");
    assert.equal(d.createdAt, "");
  });

  it("drops comments carrying the pi-review-agent marker", () => {
    const d = normalizePrContext(
      restPr,
      [],
      [
        { id: 1, body: "human comment", user: { login: "bob" }, created_at: "t1" },
        { id: 2, body: "<!-- pi-review-agent -->\nverdict", user: { login: "github-actions" }, created_at: "t2" },
        { id: 3, body: null, user: { login: "carol" }, created_at: "t3" },
      ],
      [],
      [],
    );
    assert.equal(d.comments.length, 1);
    assert.equal(d.comments[0].author, "bob");
    assert.equal(d.comments[0].body, "human comment");
  });

  it("drops self-authored reviews and review comments by marker", () => {
    const d = normalizePrContext(
      restPr,
      [],
      [],
      [
        { id: 1, body: "APPROVE", user: { login: "dave" }, state: "APPROVED", submitted_at: "t" },
        { id: 2, body: "<!-- pi-review-agent -->", user: { login: "x" }, state: "COMMENTED", submitted_at: "t" },
      ],
      [
        { id: 1, body: "nit", user: { login: "dave" }, path: "a.ts", line: 10 },
        { id: 2, body: "<!-- pi-review-agent -->", user: { login: "x" }, path: "b.ts", line: 1 },
      ],
    );
    assert.equal(d.reviews.length, 1);
    assert.equal(d.reviews[0].author, "dave");
    assert.equal(d.reviewComments.length, 1);
    assert.equal(d.reviewComments[0].path, "a.ts");
  });
});

describe("formatPrContext", () => {
  it("returns empty string when data is empty", () => {
    assert.equal(formatPrContext(emptyData), "");
  });

  it("emits title/body/author even with no discussion", () => {
    const d: PrContextData = { ...emptyData, title: "T", body: "B", author: "alice" };
    const out = formatPrContext(d);
    assert.ok(out.includes("<pull_request_context>"));
    assert.ok(out.includes("Title: T"));
    assert.ok(out.includes("Body: B"));
    assert.ok(out.includes("Author: alice"));
    assert.ok(out.includes("</pull_request_context>"));
    // No discussion sections when all empty.
    assert.ok(!out.includes("<pull_request_reviews>"));
    assert.ok(!out.includes("<pull_request_comments>"));
  });

  it("includes all four discussion sections when populated", () => {
    const d: PrContextData = {
      ...emptyData,
      title: "T",
      files: [{ path: "src/a.ts", status: "modified", additions: 3, deletions: 1 }],
      comments: [{ author: "bob", createdAt: "2026-06-29", body: "looks good" }],
      reviews: [{ author: "dave", state: "APPROVED", submittedAt: "2026-06-29", body: "ship it" }],
      reviewComments: [{ author: "dave", path: "src/a.ts", line: 5, body: "rename this" }],
    };
    const out = formatPrContext(d);
    assert.ok(out.includes("<pull_request_reviews>"));
    assert.ok(out.includes("dave (APPROVED)"));
    assert.ok(out.includes("<pull_request_review_comments>"));
    assert.ok(out.includes("src/a.ts:5: rename this"));
    assert.ok(out.includes("<pull_request_comments>"));
    assert.ok(out.includes("looks good"));
    assert.ok(out.includes("<pull_request_changed_files>"));
    assert.ok(out.includes("src/a.ts (modified) +3/-1"));
  });

  it("caps each section and reports dropped count", () => {
    const d: PrContextData = {
      ...emptyData,
      title: "T",
      files: Array.from({ length: 60 }, (_, i) => ({
        path: `f${i}.ts`,
        status: "modified",
        additions: 1,
        deletions: 1,
      })),
      comments: Array.from({ length: 40 }, (_, i) => ({
        author: "u",
        createdAt: "",
        body: `c${i}`,
      })),
    };
    const out = formatPrContext(d, { fileCap: 5, commentCap: 3 });
    assert.ok(out.includes("(55 more truncated)"), "files dropped count");
    assert.ok(out.includes("(37 more truncated)"), "comments dropped count");
    // Only 5 file lines survive.
    const filesBlock = out.split("<pull_request_changed_files>")[1]?.split("</")[0] ?? "";
    const fileLines = filesBlock.split("\n").filter((l) => l.startsWith("- "));
    assert.equal(fileLines.length, 5);
  });

  it("keeps body verbatim across multiple lines", () => {
    const d: PrContextData = { ...emptyData, title: "T", body: "line1\nline2\n- bullet" };
    const out = formatPrContext(d);
    assert.ok(out.includes("Body: line1\nline2\n- bullet"));
  });
});
