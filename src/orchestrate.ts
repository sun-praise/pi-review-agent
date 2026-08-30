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
import { loadStyleGuide } from "./style-guide.js";
import { parseSeverity, withFailedReviewerOverride, type Severity } from "./severity.js";
import { parseInlineComments, type InlineComment } from "./inline-comments.js";
import { parseChangedLines } from "./changed-lines.js";
import { verifyInlineComments, type VerifySummary } from "./verifier.js";
// buildVerifierAgent is imported LAZILY inside runTeamReview (not at module
// top level). It pulls in @earendil-works/pi-agent-core, whose `exports` map
// tsx can't resolve under `node --test`; a top-level import here breaks the
// orchestrate-modelid / orchestrate-style-guide test suites that import this
// module for its pure helpers. The lazy import keeps that load out of the test
// graph entirely.

export interface TeamReviewOptions {
  provider: Provider<"openai-completions">;
  pr: number;
  diff: string;
  /**
   * Pre-formatted PR context block (from fetchPrContext). Prepended to every
   * reviewer's prompt (NOT the coordinator — it sees reviewer outputs only).
   * Undefined/empty → diff-only. */
  prContext?: string;
  /**
   * Pre-formatted related-files context block (reverse import edges). Prepended
   * to every reviewer's prompt alongside prContext. NOT passed to the
   * coordinator (same rationale as prContext). Undefined/empty → none. */
  relatedContext?: string;
  cwd: string;
  sessionsRoot: string;
  /** e.g. "quality:1,security:1,performance:1". Default: all built-ins. */
  team?: string;
  /** Model id registered in the provider. Default "deepseek-v4-flash". */
  modelId?: string;
  /**
   * Model id for the coordinator synthesis step. Default: fall back to
   * `modelId` (the pre-per-role behavior — one model for every role).
   * Lets the coordinator run on a stronger model while reviewers stay cheap.
   */
  coordinatorModelId?: string;
  /**
   * Model id for the LLM verifier layer. Default: fall back to `modelId`.
   * The verifier's quality drives hallucination suppression, so it can be
   * upgraded independently of both reviewers and coordinator.
   */
  verifierModelId?: string;
  /**
   * Fallback model ids to try when the primary model fails permanently.
   * Passed through to every reviewer + coordinator. Example: ["gpt-4o", "mimo-v2.5"].
   */
  fallbackModels?: string[];
  /** Skip the coordinator synthesis step. Default false. */
  skipCoordinator?: boolean;
  /** Output language for review prose. Passed through to every reviewer + the coordinator. Default undefined = English. */
  language?: string;
  /** Per-review timeout/retry, passed through to every reviewer + coordinator.
   *  Default: 10-min timeout, 3 attempts, 1s backoff base. */
  timeoutMs?: number;
  maxAttempts?: number;
  retryBackoffMs?: number;
  /** Explicit path to a repository style-guide file. If omitted, common default
   *  paths are tried. The loaded guide is appended to prompts of personas that
   *  opt in via `useStyleGuide`. */
  styleGuide?: string;
  /** Skip the verifier entirely (both rule + LLM layers). Default false.
   *  When true, inline comments are posted unverified (pre-verifier behavior). */
  skipVerify?: boolean;
  /** Skip only the LLM verification layer; the rule layer still runs. Default
   *  false. Use to avoid the per-finding LLM cost while still dropping findings
   *  that point at unchanged lines / missing files. */
  skipLlmVerify?: boolean;
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
  /** Parsed severity from the coordinator output (fail-closed: missing
   *  reviewers force a CANNOT-MERGE override before this is returned).
   *  Consumers use this for the fail-on-severity exit gate. */
  severity: Severity;
  /** Structured, line-pinned findings extracted from the coordinator's
   *  `<inline_comments>` block, AFTER verification filters out demoted ones.
   *  Empty when the coordinator produced none, when skipCoordinator is true,
   *  when parsing found nothing valid, or when all findings were demoted.
   *  Consumed by the PR-comment layer to post inline review comments via
   *  the GitHub Reviews API (with fallback to a summary comment). */
  inlineComments: InlineComment[];
  /** Result of the verifier pass over the coordinator's findings. Present
   *  only when verification ran (findings existed and skipVerify was false).
   *  Carries counts + the demoted findings (with reasons) so the PR comment
   *  can show what was suppressed and why. */
  verification?: VerifySummary;
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
  "",
  "Finally, end the report with a machine-readable verdict tag on its own",
  "line — this tag is parsed by automation and is the AUTHORITATIVE",
  "verdict; the prose first line is for humans. The tag must be exactly",
  "one of (uppercase, English, never translated):",
  "",
  "<verdict>CAN MERGE</verdict>",
  "",
  "This matters because your prose may legitimately quote or discuss the",
  "verdict keywords (reviewer quotes, code under review, explanations);",
  "the tag disambiguates which one is your actual decision.",
  "Then append an optional <inline_comments> block with structured,",
  "line-pinned findings for the GitHub Reviews API. Format:",
  "",
  "<inline_comments>",
  "```json",
  "[",
  '  {"file":"src/auth.ts","line":42,"side":"RIGHT","severity":"blocking","body":"concise Markdown"}',
  "]",
  "```",
  "</inline_comments>",
  "",
  "Inline-comment rules:",
  "- One object per concrete, locatable finding. Reuse the file/line from",
  "  the reviewer reports; skip anything you cannot pin to a specific line.",
  '- side: "RIGHT" for added/context lines, "LEFT" for removed lines.',
  '- severity: "blocking" | "warning" | "suggestion" (matches the sections).',
  "- body: concise Markdown, no heading, no severity emoji. Follow the",
  "  report's language for the body prose (severity stays the English enum).",
  "- If no finding is locatable, emit an empty array [].",
].join("\n");

function coordinatorPersona(): Persona {
  return { name: "coordinator", prompt: COORDINATOR_PROMPT };
}

function buildSystemPrompt(persona: Persona, styleGuide: string | undefined): string {
  if (!styleGuide || !persona.useStyleGuide) return persona.prompt;
  return `${persona.prompt}\n\nRepository style-guide:\n${styleGuide}`;
}

export { buildSystemPrompt };

function extractVerdict(text: string): TeamReviewResult["verdict"] {
  const first = text.trim().split("\n")[0]?.toUpperCase() ?? "";
  if (first.includes("CAN MERGE") && !first.includes("CANNOT")) return "CAN MERGE";
  if (first.includes("CONDITIONAL")) return "CONDITIONAL MERGE";
  if (first.includes("CANNOT")) return "CANNOT MERGE";
  return "UNKNOWN";
}

/**
 * Verdict resolution with fallback chain:
 *   1. <verdict> tag (authoritative machine contract, see COORDINATOR_PROMPT)
 *   2. coordinator first line (canonical prose form)
 *   3. coordinator full text — the LAST keyword occurrence wins (models open
 *      with prose, quote persona verdicts mid-body, and conclude at the end)
 *   4. persona majority vote, broken by severity (CANNOT > CONDITIONAL > CAN)
 *   5. UNKNOWN
 *
 * Severity-precedence tiebreak for PERSONA votes: if reviewers split, we trust
 * the most cautious real finding rather than reporting we couldn't tell.
 *
 * History: the full-text fallback used to scan by severity order (CANNOT
 * before CONDITIONAL before CAN), so a persona verdict QUOTED early in the
 * coordinator's prose outranked its own concluding verdict (dogfood PR #52,
 * issue #53). Last-occurrence fixed that — and PR #54's own dogfood run then
 * lost to a keyword-mentioning code comment quoted in an inline-comment body
 * at a later offset than the verdict. Hence the <verdict> tag: any prose
 * scan is fragile when the output legitimately discusses the keywords.
 */
function resolveVerdict(
  coordinator: ReviewResult | null,
  personas: PersonaReview[],
): TeamReviewResult["verdict"] {
  if (coordinator) {
    const tag = coordinator.content.match(
      /<verdict>\s*(CAN MERGE|CONDITIONAL MERGE|CANNOT MERGE)\s*<\/verdict>/i,
    );
    const tagged = tag?.[1]?.toUpperCase();
    if (tagged === "CANNOT MERGE" || tagged === "CONDITIONAL MERGE" || tagged === "CAN MERGE") {
      return tagged;
    }
    const fromFirst = extractVerdict(coordinator.content);
    if (fromFirst !== "UNKNOWN") return fromFirst;
    const upper = coordinator.content.toUpperCase();
    // "CAN MERGE" is not a substring of "CANNOT MERGE"/"CONDITIONAL MERGE",
    // so the three scans don't interfere.
    const idxCannot = upper.lastIndexOf("CANNOT MERGE");
    const idxConditional = upper.lastIndexOf("CONDITIONAL MERGE");
    const idxCan = upper.lastIndexOf("CAN MERGE");
    const last = Math.max(idxCannot, idxConditional, idxCan);
    if (last < 0) {
      // No keyword anywhere — fall through to the persona vote.
    } else if (last === idxCannot) {
      return "CANNOT MERGE";
    } else if (last === idxConditional) {
      return "CONDITIONAL MERGE";
    } else {
      return "CAN MERGE";
    }
  }
  const severity: Record<TeamReviewResult["verdict"], number> = {
    "CANNOT MERGE": 3,
    "CONDITIONAL MERGE": 2,
    "CAN MERGE": 1,
    UNKNOWN: 0,
  };
  let highest: TeamReviewResult["verdict"] = "UNKNOWN";
  for (const r of personas) {
    const v = extractVerdict(r.result.content);
    if (severity[v] > severity[highest]) highest = v;
  }
  return highest;
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

  const styleGuide = loadStyleGuide(opts.cwd, opts.styleGuide);

  const personaResults = await Promise.all(
    personas.map(async (persona): Promise<PersonaReview> => {
      try {
        const result = await runReview({
          provider: opts.provider,
          pr: opts.pr,
          persona: persona.name,
          modelId: opts.modelId,
          fallbackModels: opts.fallbackModels,
          diff: opts.diff,
          prContext: opts.prContext,
          relatedContext: opts.relatedContext,
          sessionsRoot: opts.sessionsRoot,
          cwd: opts.cwd,
          systemPrompt: buildSystemPrompt(persona, styleGuide),
          language: opts.language,
          timeoutMs: opts.timeoutMs,
          maxAttempts: opts.maxAttempts,
          retryBackoffMs: opts.retryBackoffMs,
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
        modelId: opts.coordinatorModelId ?? opts.modelId,
        fallbackModels: opts.fallbackModels,
        diff: input,
        sessionsRoot: opts.sessionsRoot,
        cwd: opts.cwd,
        systemPrompt: coord.prompt,
        language: opts.language,
        timeoutMs: opts.timeoutMs,
        maxAttempts: opts.maxAttempts,
        retryBackoffMs: opts.retryBackoffMs,
      });
    } catch (err: unknown) {
      process.stderr.write(
        `coordinator failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  const verdict = resolveVerdict(coordinator, personaResults);
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

  // Fail-closed: a reviewer that produced no content is missing evidence,
  // not a clean bill of health. Force CANNOT MERGE before the gate runs so
  // the exit code and the PR comment both reflect incomplete evidence.
  const baseText = coordinator?.content ?? "";
  const failedReviewers = personaResults
    .filter((r) => Boolean(r.error) || r.result.content.trim() === "")
    .map((r) => r.persona);
  const severity = withFailedReviewerOverride(parseSeverity(baseText), failedReviewers);
  // Same fail-closed override applied to the verdict field: the PR comment
  // renders `verdict`, the exit gate reads `severity`. Without this the two
  // would disagree when reviewers fail — coordinator would say CAN MERGE
  // (it saw empty inputs) while severity says CANNOT MERGE.
  const finalVerdict: TeamReviewResult["verdict"] =
    failedReviewers.length > 0 ? "CANNOT MERGE" : verdict;
  // parseInlineComments is pure (no side effects), so the diagnostic for
  // "block present but yielded nothing" lives here at the call site rather
  // than inside the parser. Helps catch a model that keeps emitting
  // malformed JSON — otherwise the failure is silently an empty array.
  const rawComments = coordinator ? parseInlineComments(coordinator.content) : [];
  // Diagnostic: warn only when a real paired block exists but yielded
  // nothing. We check for the CLOSING tag `</inline_comments>` rather than
  // the opening tag (or calling extractAllBlocks again): the coordinator
  // discusses `<inline_comments>` in prose often, but the full closing tag
  // `</inline_comments>` appears almost only when a real block was emitted.
  // This avoids both the false-positive of `includes("<inline_comments>")`
  // and the double full-text scan that a second extractAllBlocks call would
  // cost (parseInlineComments already scanned once internally).
  if (coordinator && rawComments.length === 0 && coordinator.content.includes("</inline_comments>")) {
    process.stderr.write(
      "coordinator emitted an <inline_comments> block but it yielded no valid comments; " +
        "falling back to a summary-only review\n",
    );
  }
  // Verifier: drop findings that the rule layer (line/file checks) or the LLM
  // layer (body contradicts code) judge invalid. Demoted findings are kept in
  // `verification.demotedList` for the PR comment instead of being posted as
  // inline comments — GitHub would reject out-of-range line numbers anyway,
  // and surfacing "we caught N bad findings" is more honest than silent drop.
  let inlineComments: InlineComment[] = rawComments;
  let verification: VerifySummary | undefined;
  // Note: when rawComments is empty OR skipVerify is set, this block is
  // skipped and `verification` stays undefined. That's intentional — the
  // renderer (team-comment.ts) treats undefined as "no verification line",
  // and findings are posted as-is (pre-verifier behavior). Same when the
  // verifier throws: we catch, keep all findings, and leave verification unset.
  if (rawComments.length > 0 && !opts.skipVerify) {
    const changedLines = parseChangedLines(opts.diff);
    // Lazy import: buildVerifierAgent pulls in pi-agent-core at runtime, which
    // we must not load at module-eval time (see the note near the imports).
    const { buildVerifierAgent } = await import("./verifier-agent.js");
    const llmVerify = opts.skipLlmVerify
      ? undefined
      : buildVerifierAgent(opts.provider, {
          cwd: opts.cwd,
          modelId: opts.verifierModelId ?? opts.modelId,
        });
    try {
      const v = await verifyInlineComments(rawComments, {
        cwd: opts.cwd,
        changedLines,
        skipLlm: opts.skipLlmVerify,
        llmVerify,
      });
      inlineComments = v.comments.filter((c) => c.status === "verified");
      verification = v.summary;
      if (v.summary.demoted > 0) {
        process.stderr.write(
          `verifier: demoted ${v.summary.demoted}/${v.summary.total} inline comment(s)\n`,
        );
      }
    } catch (err: unknown) {
      // Verification must never break the review. If it throws, keep all
      // findings (unverified) and surface the error — better to post shaky
      // findings than to fail the whole run or silently drop real ones.
      process.stderr.write(
        `verifier: failed (${err instanceof Error ? err.message : String(err)}); posting findings unverified\n`,
      );
    }
  }
  return {
    personas: personaResults,
    coordinator,
    verdict: finalVerdict,
    totalCost,
    totalCacheRead,
    severity,
    inlineComments,
    verification,
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

// renderTeamComment lives in ./team-comment.ts (pure presentation, unit-tested
// without dragging in the pi-agent-core runtime). Re-export for the existing
// index.ts import site.
export { renderTeamComment } from "./team-comment.js";

// ensure dir helper kept here so callers that build paths don't need to repeat it.
export async function ensureSessionsRoot(root: string): Promise<string> {
  await fs.mkdir(path.resolve(root), { recursive: true });
  return path.resolve(root);
}
