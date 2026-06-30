import assert from "node:assert/strict";
import test from "node:test";

import { parseInlineComments } from "./inline-comments.js";

/** Helper: wrap a JSON payload in the inline_comments tag the coordinator emits. */
function block(inner: string): string {
  return `CAN MERGE\n\n### Blocking Issues\n- none\n\n<inline_comments>\n${inner}\n</inline_comments>`;
}

test("parseInlineComments", async (t) => {
  await t.test("returns [] for empty text", () => {
    assert.deepEqual(parseInlineComments(""), []);
  });

  await t.test("returns [] when no inline_comments block present", () => {
    const md = "CAN MERGE\n\n### Blocking Issues\n- foo\n### Warnings\n- bar\n";
    assert.deepEqual(parseInlineComments(md), []);
  });

  await t.test("returns [] for unclosed block (no guessing)", () => {
    const md = "CAN MERGE\n\n<inline_comments>\n[{\"file\":\"a.ts\",\"line\":1,\"side\":\"RIGHT\",\"severity\":\"blocking\",\"body\":\"x\"}";
    assert.deepEqual(parseInlineComments(md), []);
  });

  await t.test("returns [] for empty array in block", () => {
    assert.deepEqual(parseInlineComments(block("[]")), []);
  });

  await t.test("parses a full valid block", () => {
    const md = block(
      JSON.stringify([
        { file: "src/auth.ts", line: 42, side: "RIGHT", severity: "blocking", body: "SQL injection" },
        { file: "src/util.ts", line: 7, side: "LEFT", severity: "warning", body: "removed error check" },
      ]),
    );
    const got = parseInlineComments(md);
    assert.equal(got.length, 2);
    assert.equal(got[0].file, "src/auth.ts");
    assert.equal(got[0].severity, "blocking");
    assert.equal(got[1].side, "LEFT");
    assert.equal(got[1].severity, "warning");
  });

  await t.test("drops invalid entries, keeps valid ones", () => {
    const md = block(
      JSON.stringify([
        { file: "a.ts", line: 1, side: "RIGHT", severity: "blocking", body: "ok" },
        { file: "b.ts", line: 0, side: "RIGHT", severity: "blocking", body: "line < 1" }, // line=0 invalid
        { file: "c.ts", line: 3, side: "UP", severity: "blocking", body: "bad side" }, // bad side
        { file: "d.ts", line: 4, side: "RIGHT", severity: "blocking", body: "   " }, // empty body
        { file: "", line: 5, side: "RIGHT", severity: "blocking", body: "no file" }, // empty file
        { file: "e.ts", line: 6, side: "RIGHT", severity: "mystery", body: "bad severity" }, // unknown severity
        { file: "f.ts", line: 7, side: "RIGHT", severity: "suggestion", body: "ok 2" },
      ]),
    );
    const got = parseInlineComments(md);
    assert.equal(got.length, 2);
    assert.deepEqual(
      got.map((c) => c.file),
      ["a.ts", "f.ts"],
    );
  });

  await t.test("normalizes severity aliases", () => {
    const md = block(
      JSON.stringify([
        { file: "a.ts", line: 1, side: "RIGHT", severity: "blocker", body: "x" },
        { file: "b.ts", line: 2, side: "RIGHT", severity: "CRITICAL", body: "x" },
        { file: "c.ts", line: 3, side: "RIGHT", severity: "warn", body: "x" },
        { file: "d.ts", line: 4, side: "RIGHT", severity: "info", body: "x" },
        { file: "e.ts", line: 5, side: "RIGHT", severity: "nit", body: "x" },
      ]),
    );
    const got = parseInlineComments(md);
    assert.deepEqual(
      got.map((c) => c.severity),
      ["blocking", "blocking", "warning", "suggestion", "suggestion"],
    );
  });

  await t.test("parses fenced ```json block", () => {
    const md =
      "CANNOT MERGE\n\n### Blocking Issues\n- foo\n\n<inline_comments>\n" +
      "```json\n" +
      "[\n  {\"file\":\"a.ts\",\"line\":1,\"side\":\"RIGHT\",\"severity\":\"blocking\",\"body\":\"x\"}\n]\n" +
      "```\n" +
      "</inline_comments>";
    const got = parseInlineComments(md);
    assert.equal(got.length, 1);
    assert.equal(got[0].file, "a.ts");
  });

  await t.test("handles balanced brackets inside string literals", () => {
    // The ] inside the body string must not close the array early.
    const md = block(
      `[
        {"file":"a.ts","line":1,"side":"RIGHT","severity":"warning","body":"use foo[0] not foo[1]"}
      ]`,
    );
    const got = parseInlineComments(md);
    assert.equal(got.length, 1);
    assert.equal(got[0].body, "use foo[0] not foo[1]");
  });

  await t.test("tolerates trailing prose after the JSON array", () => {
    const md = block(
      `[]
      That's all for this review.`,
    );
    // Empty array parsed → returns [] (doesn't fall through to prose).
    assert.deepEqual(parseInlineComments(md), []);
  });

  await t.test("block after multiple markdown sections does not collide", () => {
    // Confirms the block living at the end doesn't trip up when sections
    // contain code spans / numbers that look like JSON fragments.
    const md =
      "CONDITIONAL MERGE\n\n" +
      "### Blocking Issues\n- [P0] auth bypass at line 42\n\n" +
      "### Warnings\n- none `[1, 2, 3]`\n\n" +
      '<inline_comments>\n```json\n[{"file":"x.ts","line":42,"side":"RIGHT","severity":"blocking","body":"bypass"}]\n```\n</inline_comments>';
    const got = parseInlineComments(md);
    assert.equal(got.length, 1);
    assert.equal(got[0].file, "x.ts");
  });
});
