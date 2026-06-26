/**
 * Minimal review-agent CLI entry point.
 *
 * Run:
 *   LITELLM_API_KEY=... \
 *   tsx src/index.ts --pr 123 --diff-file ./diff.txt --persona quality
 *
 * On a first run, a new session is created under ./sessions/<pr>/<persona>.jsonl.
 * On subsequent runs with the same (pr, persona), the session is reopened and
 * continued; the shared system+history prefix hits DeepSeek's content cache,
 * so cache_read > 0 and the cost reflects the discounted rate.
 */
import { createLiteLLMDeepSeekProvider } from "./provider.js";
import { runReview } from "./review.js";

function parseArgs(argv: string[]): {
  pr: number;
  diffFile: string;
  persona: string;
  baseURL: string;
  sessionsRoot: string;
} {
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i += 2) {
    const k = argv[i]?.replace(/^--/, "");
    args[k ?? ""] = argv[i + 1] ?? "";
  }
  const pr = Number(args.pr);
  if (!Number.isFinite(pr) || pr <= 0) {
    throw new Error(`--pr <number> required (got ${args.pr ?? "<missing>"})`);
  }
  if (!args.diffFile) throw new Error("--diff-file <path> required");
  if (!args.persona) throw new Error("--persona <name> required");
  return {
    pr,
    diffFile: args.diffFile,
    persona: args.persona,
    baseURL: args.baseURL ?? process.env.LITELLM_BASE_URL ?? "https://llm.sun-praise.com/v1",
    sessionsRoot: args.sessionsRoot ?? "./sessions",
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  const diff = await import("node:fs").then((fs) => fs.readFileSync(opts.diffFile, "utf8"));

  const provider = createLiteLLMDeepSeekProvider({ baseURL: opts.baseURL });
  const result = await runReview({
    provider,
    pr: opts.pr,
    persona: opts.persona,
    diff,
    sessionsRoot: opts.sessionsRoot,
  });

  process.stdout.write(`\n=== review (${opts.persona}) ===\n${result.content}\n`);
  process.stdout.write(
    `\n=== usage ===\n` +
      `input:       ${result.usage.input}\n` +
      `output:      ${result.usage.output}\n` +
      `cacheRead:   ${result.usage.cacheRead}  (hit → discounted billing)\n` +
      `cacheWrite:  ${result.usage.cacheWrite}\n` +
      `cost total:  $${result.usage.costTotal.toFixed(6)}\n`,
  );
}

main().catch((err) => {
  console.error("pi-review-agent failed:", err);
  process.exit(1);
});
