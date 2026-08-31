/**
 * Pure presentation: render a team review result as a markdown PR comment.
 *
 * Split into its own module so it can be unit-tested without pulling in the
 * review runtime (which drags in @earendil-works/pi-agent-core and its
 * `exports` map that tsx can't resolve under `node --test`). Type-only
 * imports here are erased at compile time.
 */
import type { ReviewResult } from "./review.js";
import type { VerifySummary } from "./verifier.js";
import { formatCost, type CurrencyOptions, DEFAULT_USD_CNY_RATE } from "./currency.js";

export type Verdict = "CAN MERGE" | "CONDITIONAL MERGE" | "CANNOT MERGE" | "UNKNOWN";

export interface CommentPersonaView {
  persona: string;
  result: ReviewResult;
  error?: string;
}

export interface CommentTeamView {
  personas: CommentPersonaView[];
  coordinator: { content: string } | null;
  verdict: Verdict;
  totalCost: number;
  totalCacheRead: number;
  /** Verifier roll-up. Present only when verification ran over findings. */
  verification?: VerifySummary;
}

/** Options for rendering the cost figures. Defaults keep the historical USD
 *  rendering; `currency: "cny"` converts at the given rate (#57). Internal
 *  accounting stays USD — this is display-layer only. */
export interface CommentRenderOptions {
  currency?: CurrencyOptions;
}

/** Render a team result as a markdown comment body for PR posting. */
export function renderTeamComment(
  result: CommentTeamView,
  opts: CommentRenderOptions = {},
): string {
  const currency = opts.currency ?? { currency: "usd", rate: DEFAULT_USD_CNY_RATE };
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

  if (result.verification && result.verification.total > 0) {
    const v = result.verification;
    lines.push(
      `> 🔍 **Verification:** ${v.verified}/${v.total} inline findings independently verified` +
        (v.demoted > 0 ? ` · ${v.demoted} demoted (see below)` : ""),
    );
    lines.push("");
  }

  const failedNames = result.personas
    .filter((r) => Boolean(r.error) || r.result.content.trim() === "")
    .map((r) => r.persona);
  if (failedNames.length > 0) {
    lines.push(
      `> ⚠️ **Fail-closed:** ${failedNames.length} reviewer(s) produced no output ` +
        `(${failedNames.join(", ")}). Verdict forced to CANNOT MERGE — the coordinator's ` +
        `synthesis below was computed from incomplete evidence and must not be trusted.`,
    );
    lines.push("");
  }

  if (result.coordinator) {
    lines.push("<details><summary><b>Coordinator synthesis</b></summary>");
    lines.push("");
    lines.push(result.coordinator.content);
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }
  if (result.verification && result.verification.demoted > 0) {
    lines.push(
      `<details><summary><b>⚠️ Demoted findings</b> (${result.verification.demoted})</summary>`,
    );
    lines.push("");
    lines.push(
      "_The verifier suppressed these as unverified (line not in the diff, file " +
        "not found, or the description contradicts the code). They are NOT posted " +
        "as inline comments._",
    );
    lines.push("");
    for (const d of result.verification.demotedList) {
      lines.push(`- \`${d.file}:${d.line}\` (${d.side}) — _${d.demoteReason ?? "unverified"}_ — ${d.body}`);
    }
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }
  for (const r of result.personas) {
    const cacheNote = r.result.usage.cacheRead > 0 ? ` · cacheRead ${r.result.usage.cacheRead}` : "";
    lines.push(
      `<details><summary><b>${r.persona}</b> · ${formatCost(r.result.usage.costTotal, currency)}${cacheNote}</summary>`,
    );
    lines.push("");
    lines.push(r.error ? `_(review failed: ${r.error})_` : r.result.content);
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }
  lines.push("---");
  lines.push(
    `<sub>pi-review-agent · total cost ${formatCost(result.totalCost, currency)} · cacheRead ${result.totalCacheRead}</sub>`,
  );
  return lines.join("\n");
}
