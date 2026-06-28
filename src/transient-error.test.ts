import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isTransientReviewerError } from "./transient-error.js";

function err(msg: string): Error {
  return new Error(msg);
}

describe("isTransientReviewerError", () => {
  it("treats network blips as transient", () => {
    assert.equal(isTransientReviewerError(err("fetch failed: ECONNRESET")), true);
    assert.equal(isTransientReviewerError(err("UND_ERR socket hang up")), true);
    assert.equal(isTransientReviewerError(err("stream terminated")), true);
  });

  it("treats 429 rate-limit and 5xx as transient", () => {
    assert.equal(isTransientReviewerError(err("review completed with no usage — 429 Too Many Requests")), true);
    assert.equal(isTransientReviewerError(err("review completed with no usage — 502 Bad Gateway")), true);
  });

  it("treats 4xx (except 429) as permanent — a 413 payload-too-large won't fix itself", () => {
    assert.equal(
      isTransientReviewerError(err("review completed with no usage — 413 <html>Payload Too Large")),
      false,
    );
    assert.equal(isTransientReviewerError(err("review completed with no usage — 400 bad request")), false);
  });

  it("treats our own deadline as permanent (budget spent)", () => {
    assert.equal(isTransientReviewerError(err("quality timed out after 600000ms")), false);
  });
});
