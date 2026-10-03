import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readReviewCount, bumpReviewCount, REVIEW_COUNT_FILENAME } from "./review-counter.js";

async function tmpRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-review-counter-"));
}

describe("readReviewCount (fail-open: unusable = 0)", () => {
  it("missing file counts as 0", async () => {
    const root = await tmpRoot();
    assert.equal(await readReviewCount(join(root, "42", REVIEW_COUNT_FILENAME)), 0);
  });

  it("reads a recorded count", async () => {
    const root = await tmpRoot();
    const file = join(root, "42", REVIEW_COUNT_FILENAME);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, '{"count":7}\n');
    assert.equal(await readReviewCount(file), 7);
  });

  it("corrupt JSON, wrong shape, negative, or non-finite counts as 0", async () => {
    const root = await tmpRoot();
    for (const [i, body] of ["{oops", "[]", '"5"', '{"count":-3}', '{"count":1e999}', "{}"].entries()) {
      const file = join(root, `case-${i}`, REVIEW_COUNT_FILENAME);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, body);
      assert.equal(await readReviewCount(file), 0, `body ${body}`);
    }
  });
});

describe("bumpReviewCount", () => {
  it("creates the directory and counts from 0", async () => {
    const root = await tmpRoot();
    const file = join(root, "42", REVIEW_COUNT_FILENAME);
    assert.equal(await bumpReviewCount(file), 1);
    assert.equal(await readFile(file, "utf8"), '{"count":1}\n');
  });

  it("increments a recorded count and keeps failing bodies on the 0 track", async () => {
    const root = await tmpRoot();
    const file = join(root, "42", REVIEW_COUNT_FILENAME);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, '{"count":7}\n');
    assert.equal(await bumpReviewCount(file), 8);

    await writeFile(file, "{corrupt");
    assert.equal(await bumpReviewCount(file), 1);
    assert.equal(await readFile(file, "utf8"), '{"count":1}\n');
  });
});
