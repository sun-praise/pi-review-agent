import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planGiteaPages, lastPageUrl, GITEA_ANCHOR_PAGE_CAP } from "./pagination.js";

describe("planGiteaPages — X-Total-Count known", () => {
  it("single page: nothing beyond the first", () => {
    assert.deepEqual(planGiteaPages(30, 50), []);
  });

  it("few pages: all remaining pages are the newest window", () => {
    assert.deepEqual(planGiteaPages(120, 50), [2, 3]);
    assert.deepEqual(planGiteaPages(250, 50), [2, 3, 4, 5]);
  });

  it("busy PR: jumps to the END, never the oldest pages", () => {
    // 600 comments = 12 pages; the newest 5-page window is 9..12.
    assert.deepEqual(planGiteaPages(600, 50), [9, 10, 11, 12]);
    // Regression guard: pages 2..5 (the oldest window) must never be the
    // answer when more pages exist.
    const planned = planGiteaPages(600, 50);
    assert.ok(!planned.includes(2) && !planned.includes(5));
    assert.ok(planned.includes(12), "the last page must be fetched");
  });

  it("respects the cap when configured smaller", () => {
    assert.deepEqual(planGiteaPages(600, 50, 3), [11, 12]);
  });
});

describe("planGiteaPages — X-Total-Count absent", () => {
  it("walks forward from page 2 up to the cap; caller stops at short pages", () => {
    assert.deepEqual(planGiteaPages(null, 50), [2, 3, 4, 5]);
    assert.equal(GITEA_ANCHOR_PAGE_CAP, 5);
  });
});

describe("lastPageUrl", () => {
  it("returns null without a header or without rel=last", () => {
    assert.equal(lastPageUrl(null), null);
    assert.equal(lastPageUrl('<https://api/x?page=2>; rel="next"'), null);
  });

  it("extracts the rel=last target among several links", () => {
    const link =
      '<https://api/x?page=2>; rel="next", <https://api/x?page=17>; rel="last"';
    assert.equal(lastPageUrl(link), "https://api/x?page=17");
  });

  it("tolerates malformed segments", () => {
    assert.equal(lastPageUrl("garbage, <>; rel=\"last\""), null);
  });
});
