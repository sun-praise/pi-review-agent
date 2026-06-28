/**
 * Pure presentation: render a team review result as a markdown PR comment.
 *
 * Split into its own module so it can be unit-tested without pulling in the
 * review runtime (which drags in @earendil-works/pi-agent-core and its
 * `exports` map that tsx can't resolve under `node --test`). Type-only
 * imports here are erased at compile time.
 */
import type { ReviewResult } from "./review.js";

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
}

/** Render a team result as a markdown comment body for PR posting. */
export function renderTeamComment(result: CommentTeamView): string {
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
  for (const r of result.personas) {
    const cacheNote = r.result.usage.cacheRead > 0 ? ` · cacheRead ${r.result.usage.cacheRead}` : "";
    lines.push(
      `<details><summary><b>${r.persona}</b> · $${r.result.usage.costTotal.toFixed(6)}${cacheNote}</summary>`,
    );
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
