/**
 * Cache-read demo: proves pi-ai surfaces DeepSeek's prompt-cache hits.
 *
 * Run twice in a row with the same PR/persona; the second run should show
 * a large cacheRead (DeepSeek caches the shared system+history prefix).
 *
 *   LITELLM_API_KEY=... tsx examples/demo-cache.ts
 *
 * No real PR required — uses an in-script dummy diff. The point is to see
 * usage.cacheRead > 0 on the second run.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createLiteLLMDeepSeekProvider } from "../src/provider.js";
import { runReview } from "../src/review.js";

async function main() {
  if (!process.env.LITELLM_API_KEY) {
    throw new Error("LITELLM_API_KEY env var required");
  }
  const baseURL = process.env.LITELLM_BASE_URL ?? "https://llm.sun-praise.com/v1";
  const sessionsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-review-demo-"));
  const provider = createLiteLLMDeepSeekProvider({ baseURL });

  // The system prompt is padded to comfortably exceed DeepSeek's content-cache
  // threshold (≥256 tokens). On run 2, this prefix is the warmed cache entry,
  // so usage.cacheRead should be > 0 and cost should drop vs run 1.
  const personaGuide =
    "You are a senior code reviewer. Cite file:line for each finding, " +
    "classify as blocker / warning / suggestion, and prefer specific concrete " +
    "remedies over generic advice. Do not invent issues if the diff is fine. " +
    "Focus on correctness, then security, then clarity, in that order. ".repeat(40);

  const diff = [
    "diff --git a/foo.ts b/foo.ts",
    "index 111..222 100644",
    "--- a/foo.ts",
    "+++ b/foo.ts",
    "@@ -1,3 +1,5 @@",
    " export function add(a: number, b: number) {",
    "-  return a + b;",
    "+  // bug: was forgetting to handle NaN",
    "+  if (Number.isNaN(a) || Number.isNaN(b)) return 0;",
    "+  return a + b;",
    " }",
  ].join("\n");

  for (const run of [1, 2]) {
    const result = await runReview({
      provider,
      pr: 999,
      persona: "quality",
      diff,
      sessionsRoot,
      systemPrompt: personaGuide,
      maxOutputTokens: 200,
    });
    console.log(`\n=== run ${run} (resumed=${result.resumed}) ===`);
    console.log("review:", result.content.slice(0, 120));
    console.log(
      "usage:",
      JSON.stringify(
        {
          input: result.usage.input,
          output: result.usage.output,
          cacheRead: result.usage.cacheRead,
          costTotal: result.usage.costTotal,
        },
        null,
        0,
      ),
    );
  }

  await fs.rm(sessionsRoot, { recursive: true, force: true });
}

main().catch((err) => {
  console.error("demo failed:", err);
  process.exit(1);
});
