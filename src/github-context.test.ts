import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizePrContext, formatPrContext, parseNextLink, truncateBytes, type PrContextData } from "./github-context.js";

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
  bodyTruncated: false,
  author: "",
  createdAt: "",
  baseRef: "",
  headRef: "",
  files: [],
  comments: [],
  reviews: [],
  reviewComments: [],
  totals: { files: 0, comments: 0, reviews: 0, reviewComments: 0 },
  fetchedAll: { files: true, comments: true, reviews: true, reviewComments: true },
};

const filled = (): PrContextData => ({
  ...emptyData,
  title: "T",
  body: "B",
  files: [{ path: "src/a.ts", status: "modified", additions: 3, deletions: 1 }],
  comments: [{ author: "bob", createdAt: "2026-06-29", body: "looks good" }],
  reviews: [{ author: "dave", state: "APPROVED", submittedAt: "2026-06-29", body: "ship it" }],
  reviewComments: [{ author: "dave", path: "src/a.ts", line: 5, body: "rename this" }],
  totals: { files: 1, comments: 1, reviews: 1, reviewComments: 1 },
});

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

  it("drops comments carrying the exact pi-review-agent marker", () => {
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

  it("keeps a comment that only mentions pi-review-agent-example (no false positive)", () => {
    const d = normalizePrContext(
      restPr,
      [],
      [
        { id: 1, body: "see <!-- pi-review-agent-example --> for details", user: { login: "bob" }, created_at: "t" },
      ],
      [],
      [],
    );
    assert.equal(d.comments.length, 1);
  });

  it("drops self-authored reviews and review comments by exact marker", () => {
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

describe("parseNextLink", () => {
  it("returns null when no rel=next", () => {
    assert.equal(parseNextLink(null), null);
    assert.equal(parseNextLink('<https://x?page=5>; rel="last"'), null);
  });

  it("extracts the next URL from a multi-link header", () => {
    const header =
      '<https://api.github.com/repos/o/r/issues/1/comments?page=2>; rel="next", ' +
      '<https://api.github.com/repos/o/r/issues/1/comments?page=5>; rel="last"';
    assert.equal(
      parseNextLink(header),
      "https://api.github.com/repos/o/r/issues/1/comments?page=2",
    );
  });
});

describe("truncateBytes", () => {
  it("leaves short strings untouched", () => {
    const r = truncateBytes("hello", 100);
    assert.equal(r.text, "hello");
    assert.equal(r.truncated, false);
  });

  it("cuts ASCII at the byte boundary", () => {
    const r = truncateBytes("abcdefgh", 4);
    assert.equal(r.text, "abcd");
    assert.equal(r.truncated, true);
  });

  it("never splits a multibyte character (strips dangling U+FFFD)", () => {
    // "中" is 3 bytes in UTF-8. Asking for 4 bytes from "a中b" would slice
    // into the middle of "中"; the result must not contain a broken char.
    const r = truncateBytes("a中b", 4);
    assert.equal(r.truncated, true);
    assert.ok(!r.text.includes("\uFFFD"), "must not contain replacement char");
    // The ASCII 'a' survives; "中" is dropped because it didn't fit.
    assert.ok(r.text.startsWith("a"));
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
    assert.ok(out.includes("Body:"));
    assert.ok(out.includes("B"));
    assert.ok(out.includes("Author: alice"));
    assert.ok(out.includes("</pull_request_context>"));
    assert.ok(!out.includes("<pull_request_reviews>"));
    assert.ok(!out.includes("<pull_request_comments>"));
  });

  it("includes all four discussion sections when populated", () => {
    const out = formatPrContext(filled());
    assert.ok(out.includes("<pull_request_reviews>"));
    assert.ok(out.includes("dave (APPROVED)"));
    assert.ok(out.includes("<pull_request_review_comments>"));
    assert.ok(out.includes("src/a.ts:5: rename this"));
    assert.ok(out.includes("<pull_request_comments>"));
    assert.ok(out.includes("looks good"));
    assert.ok(out.includes("<pull_request_changed_files>"));
    assert.ok(out.includes("src/a.ts (modified) +3/-1"));
  });

  it("caps each section and reports dropped count from the true total", () => {
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
      totals: { files: 60, comments: 40, reviews: 0, reviewComments: 0 },
    };
    const out = formatPrContext(d, { fileCap: 5, commentCap: 3 });
    assert.ok(out.includes("(55 more truncated)"), "files dropped = 60 - 5");
    assert.ok(out.includes("(37 more truncated)"), "comments dropped = 40 - 3");
    const filesBlock = out.split("<pull_request_changed_files>")[1]?.split("</")[0] ?? "";
    const fileLines = filesBlock.split("\n").filter((l) => l.startsWith("- "));
    assert.equal(fileLines.length, 5);
  });

  it("flags when the fetch itself was capped (dropped is a floor, not exact)", () => {
    const d: PrContextData = {
      ...emptyData,
      title: "T",
      files: Array.from({ length: 300 }, (_, i) => ({
        path: `f${i}.ts`,
        status: "modified",
        additions: 1,
        deletions: 1,
      })),
      totals: { files: 300, comments: 0, reviews: 0, reviewComments: 0 },
      fetchedAll: { files: false, comments: true, reviews: true, reviewComments: true },
    };
    const out = formatPrContext(d, { fileCap: 50 });
    assert.ok(out.includes("real total higher"), "must warn fetch was capped");
    assert.ok(out.includes("+"), "dropped count carries a + qualifier");
  });

  it("truncates a long body to the byte cap and notes it", () => {
    const longBody = "x".repeat(20000);
    const d: PrContextData = { ...emptyData, title: "T", body: longBody };
    const out = formatPrContext(d, { bodyByteCap: 100 });
    assert.ok(out.includes("(truncated to 100 bytes)"));
    // The body line is indented; verify truncation actually happened.
    const bodyLine = out.split("Body:")[1]?.split("\n").slice(1, 3).join(" ") ?? "";
    assert.ok(bodyLine.length < longBody.length);
  });

  it("indents continuation lines of a multi-line body", () => {
    const d: PrContextData = { ...emptyData, title: "T", body: "line1\nline2" };
    const out = formatPrContext(d);
    assert.ok(out.includes("  line1\n  line2"), "both lines indented");
  });
});
