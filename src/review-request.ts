/**
 * Assembly of the reviewer's user prompt. Extracted from review.ts (which
 * imports pi-agent-core at module scope and therefore cannot be loaded by
 * `node --test` — same rationale as team-comment.ts) so the prompt contract,
 * especially the incremental-review wording, is unit-testable.
 *
 * Layout: context blocks first (PR metadata, related files, previous review
 * round), the diff last, so the review instruction sits directly above the
 * payload. The full-review output is byte-identical to the format review.ts
 * assembled before the extraction.
 *
 * Pure: no fs, no env, no side effects.
 */
import { SELF_MARKER, SHA_LINE_PREFIX } from "./review-anchor.js";

export interface ReviewRequestInput {
  diff: string;
  /** PR metadata block (fetchPrContext). Empty/undefined → omitted. */
  prContext?: string;
  /** Related-files block (reverse import edges). Empty/undefined → omitted. */
  relatedContext?: string;
  /** Incremental mode: the commit the previous review round covered. When
   *  set, `diff` holds only the delta since then and the request wording
   *  switches to the incremental contract (focus on the delta, verdict on
   *  the PR's cumulative state). */
  incrementalSince?: string;
  /** Incremental mode: the previous round's posted summary. The findings in
   *  it must be re-checked against the delta before being repeated or
   *  dismissed. Wrapped in a labeled block, markers stripped, length-capped
   *  (the value of a summary older than the cap is the findings, which the
   *  reviewer can restate from its own session history anyway). */
  previousReview?: string;
}

/** Cap for the injected previous review, in characters. */
const MAX_PREVIOUS_REVIEW_CHARS = 6000;

function stripMarkers(body: string): string {
  return body
    .split("\n")
    .filter((line) => line.trim() !== SELF_MARKER && !line.trim().startsWith(SHA_LINE_PREFIX))
    .join("\n")
    .trim();
}

/** Previous review, markers stripped and capped, with an explicit notice when
 *  the cap bites (a silent cut mid-sentence would read as the model's own
 *  truncation). */
function renderPreviousReview(body: string): string {
  const stripped = stripMarkers(body);
  if (stripped.length <= MAX_PREVIOUS_REVIEW_CHARS) return stripped;
  return (
    stripped.slice(0, MAX_PREVIOUS_REVIEW_CHARS) +
    `\n[previous review truncated at ${MAX_PREVIOUS_REVIEW_CHARS} chars]`
  );
}

export function buildReviewRequest(input: ReviewRequestInput): string {
  const blocks: string[] = [];
  if (input.prContext && input.prContext.trim()) blocks.push(input.prContext);
  if (input.relatedContext && input.relatedContext.trim()) blocks.push(input.relatedContext);
  if (input.incrementalSince && input.previousReview && input.previousReview.trim()) {
    blocks.push(
      "<previous_review>\n" +
        `Summary posted by the previous review round, which reviewed commit ${input.incrementalSince}. ` +
        "The diff below contains only the changes since that commit: check the findings below " +
        "against the new changes before repeating or dismissing them — an unresolved finding " +
        "still applies and may still block the merge.\n\n" +
        renderPreviousReview(input.previousReview) +
        "\n</previous_review>",
    );
  }
  const prefix = blocks.join("\n\n");

  if (input.incrementalSince) {
    const request =
      `=== Review request ===\n` +
      `Incremental review: the diff below contains ONLY the changes since ${input.incrementalSince}, ` +
      `the last reviewed commit. Focus on those changes, but judge the verdict on the PR's ` +
      `cumulative state — unresolved findings from the previous round may still block the merge.\n\n` +
      `New changes since ${input.incrementalSince}:\n\n${input.diff}`;
    return prefix ? `${prefix}\n\n${request}` : request;
  }
  // Full review: byte-identical to the pre-extraction format (including the
  // no-context variant that omits the "=== Review request ===" header).
  if (!prefix) return `Review this diff:\n\n${input.diff}`;
  return `${prefix}\n\n=== Review request ===\nReview this diff:\n\n${input.diff}`;
}
