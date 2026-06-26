/**
 * Team orchestration: run N personas in parallel, then a coordinator that
 * synthesizes their outputs into a single verdict.
 *
 * Parallelism: each persona runs as its own Agent + its own session JSONL, so
 * they don't share cache prefixes (their system prompts differ). Run them with
 * Promise.all — they're independent. Each surfaces its own cacheRead.
 *
 * Coordinator: after personas finish, their outputs are concatenated into a
 * single user message and fed to a coordinator Agent (its own session too).
 * The coordinator decides the overall verdict and dedupes/merges findings.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Provider } from "@earendil-works/pi-ai";
import { runReview, type ReviewResult } from "./review.js";
import { loadPersonas, resolveTeam, type Persona } from "./personas.js";

export interface TeamReviewOptions {
  provider: Provider<"openai-completions">;
  pr: number;
  diff: string;
  cwd: string;
  sessionsRoot: string;
  /** e.g. "quality:1,security:1,performance:1". Default: all built-ins. */
  team?: string;
  /** Skip the coordinator synthesis step. Default false. */
  skipCoordinator?: boolean;
}

export interface PersonaReview {
  persona: string;
  result: ReviewResult;
  error?: string;
}

export interface TeamReviewResult {
  personas: PersonaReview[];
  coordinator: ReviewResult | null;
  /** Final verdict surfaced from the coordinator (or majority of personas). */
  verdict: "CAN MERGE" | "CONDITIONAL MERGE" | "CANNOT MERGE" | "UNKNOWN";
  totalCost: number;
  totalCacheRead: number;
}

const COORDINATOR_PROMPT = [
  "You are the review coordinator. Multiple specialist reviewers have analyzed",
  "the same PR; their reports follow. Synthesize a single verdict.",
  "",
  "Steps:",
  "1. Read every reviewer's decision and findings.",
  "2. Deduplicate overlapping findings (same issue raised by multiple reviewers).",
  "3. Resolve conflicts: if reviewers disagree on severity, pick the higher one",
  "   unless the lower-severity reviewer provided concrete evidence the issue",
  "   doesn't apply to the current code.",
  "4. Decide the overall verdict:",
  "   - CAN MERGE: no reviewer found blocking issues",
  "   - CONDITIONAL MERGE: at least one blocking issue, but clearly scoped and",
  "     fixable without re-review",
  "   - CANNOT MERGE: blocking issues are broad, ambiguous, or correctness-breaking",
  "",
  "Output format:",
  "- First line: one of CAN MERGE / CONDITIONAL MERGE / CANNOT MERGE",
  "- Then a one-paragraph summary",
  "- Then 'Blocking Issues' (merged + deduped)",
  "- Then 'Warnings' (merged + deduped)",
  "- Then 'Suggestions' (merged + deduped)",
].join("\n");

function coordinatorPersona(): Persona {
  return { name: "coordinator", prompt: COORDINATOR_PROMPT };
}

function extractVerdict(text: string): TeamReviewResult["verdict"] {
  const first = text.trim().split("\n")[0]?.toUpperCase() ?? "";
  if (first.includes("CAN MERGE") && !first.includes("CANNOT")) return "CAN MERGE";
  if (first.includes("CONDITIONAL")) return "CONDITIONAL MERGE";
  if (first.includes("CANNOT")) return "CANNOT MERGE";
  return "UNKNOWN";
}

function buildCoordinatorInput(reviews: PersonaReview[]): string {
  const parts: string[] = [];
  for (const r of reviews) {
    parts.push(`## Reviewer: ${r.persona}`);
    parts.push("```");
    parts.push(r.result.content);
    parts.push("```");
    parts.push("");
  }
  return [
    "Synthesize the following reviewer reports into a single verdict.",
    "",
    ...parts,
  ].join("\n");
}

export async function runTeamReview(opts: TeamReviewOptions): Promise<TeamReviewResult> {
  const available = loadPersonas(opts.cwd);
  const { personas, unknown } = resolveTeam(opts.team, available);
  if (unknown.length > 0) {
    throw new Error(
      `unknown personas in team spec: ${unknown.join(", ")}. ` +
        `available: ${available.map((p) => p.name).join(", ")}`,
    );
  }
  if (personas.length === 0) {
    throw new Error("no personas resolved; pass --team or add .github/reviewers/*.yaml");
  }

  const personaResults = await Promise.all(
    personas.map(async (persona): Promise<PersonaReview> => {
      try {
        const result = await runReview({
          provider: opts.provider,
          pr: opts.pr,
          persona: persona.name,
          diff: opts.diff,
          sessionsRoot: opts.sessionsRoot,
          cwd: opts.cwd,
          systemPrompt: persona.prompt,
        });
        return { persona: persona.name, result };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          persona: persona.name,
          result: emptyReview(opts.pr, persona.name),
          error: message,
        };
      }
    }),
  );

  let coordinator: ReviewResult | null = null;
  if (!opts.skipCoordinator) {
    const coord = coordinatorPersona();
    const input = buildCoordinatorInput(personaResults);
    try {
      coordinator = await runReview({
        provider: opts.provider,
        pr: opts.pr,
        persona: coord.name,
        diff: input,
        sessionsRoot: opts.sessionsRoot,
        cwd: opts.cwd,
        systemPrompt: coord.prompt,
      });
    } catch (err: unknown) {
      process.stderr.write(
        `coordinator failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  const verdictSource = coordinator?.content ?? personaResults[0]?.result.content ?? "";
  const verdict = extractVerdict(verdictSource);

  let totalCost = 0;
  let totalCacheRead = 0;
  for (const r of personaResults) {
    totalCost += r.result.usage.costTotal;
    totalCacheRead += r.result.usage.cacheRead;
  }
  if (coordinator) {
    totalCost += coordinator.usage.costTotal;
    totalCacheRead += coordinator.usage.cacheRead;
  }

  return {
    personas: personaResults,
    coordinator,
    verdict,
    totalCost,
    totalCacheRead,
  };
}

function emptyReview(pr: number, persona: string): ReviewResult {
  return {
    content: "(review failed)",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costTotal: 0 },
    resumed: false,
    sessionId: `${pr}-${persona}`,
    newMessages: [],
  };
}

/** Render a team result as a markdown comment body for PR posting. */
export function renderTeamComment(result: TeamReviewResult): string {
  const lines: string[] = [];
  const icon =
    result.verdict === "CAN MERGE"
      ? "✅"
      : result.verdict === "CONDITIONAL MERGE"
        ? "⚠️"
        : result.verdict === "CANNOT MERGE"
          ? "🚫"
          : "❓";
  lines.push(`${icon} ${result.verdict}`);
  lines.push("");
  if (result.coordinator) {
    lines.push("<details><summary><b>Coordinator synthesis</b></summary>");
    lines.push("");
    lines.push(result.coordinator.content);
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }
  for (const r of result.personas) {
    const cacheNote = r.result.usage.cacheRead > 0 ? ` · cacheRead ${r.result.usage.cacheRead}` : "";
    lines.push(`<details><summary><b>${r.persona}</b> · $${r.result.usage.costTotal.toFixed(6)}${cacheNote}</summary>`);
    lines.push("");
    lines.push(r.error ? `_(review failed: ${r.error})_` : r.result.content);
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }
  lines.push("---");
  lines.push(
    `<sub>pi-review-agent · total cost $${result.totalCost.toFixed(6)} · cacheRead ${result.totalCacheRead}</sub>`,
  );
  return lines.join("\n");
}

// ensure dir helper kept here so callers that build paths don't need to repeat it.
export async function ensureSessionsRoot(root: string): Promise<string> {
  await fs.mkdir(path.resolve(root), { recursive: true });
  return path.resolve(root);
}
