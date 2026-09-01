# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


## [1.7.0] - 2026-09-01

### Added

- **Display-currency for cost figures** (#57): new `currency` ("usd" default
  / "cny") and `exchange-rate` (USD→CNY, default 7.2) inputs convert the cost
  lines in the PR comment, step summary, and logs to the chosen currency.
  Internal accounting, `cost-overrides`, and the `totalCost` output stay USD —
  conversion is display-layer only. Invalid values warn on stderr and fall
  back to usd/7.2; no live-rate fetching.

### Fixed

- **Stream-error runs no longer pass as reviews** (#59): a mid-stream failure
  used to leave the collector holding the previous turn's pre-tool-call
  fragment plus stale usage, so all four personas could "succeed" with
  thinking snippets and an UNKNOWN verdict while the check stayed green.
  Terminal `stopReason: error|aborted` now fails the attempt, engaging the
  transient retry, model-fallback, and fail-closed (CANNOT MERGE) paths.
- **Top-level summary comment always refreshes** (#59): runs with inline
  findings posted only a PR review (append-only) and never updated the
  standing comment, so a broken first comment stayed forever across re-runs
  and new SHAs. The review is posted AND the summary comment is refreshed
  every run (new SHA → new comment, same-SHA re-run → replaces in place).
- **Transient-retry for comment posting** (#59): one `fetch failed` on a
  self-hosted runner used to discard a finished review (`PR comment:
  skipped`). GitHub/Gitea comment create/update and review POSTs now retry
  transient errors (network, 429, 5xx) with jittered backoff; permanent 4xx
  still fall through immediately. Review POST retries reconcile against the
  server first (list reviews for the commit) so a lost response can't
  double-post a review thread.
- **Session transcripts no longer duplicate assistant messages**: the
  collector handled both `message_end` and `turn_end` (which re-carries the
  same message), writing every assistant turn twice into the JSONL resume
  file.

## [1.6.0] - 2026-08-31

### Added

- **Per-role model configuration** (#44): new `coordinator-model` and
  `verifier-model` inputs (CLI `--coordinator-model` / `--verifier-model`,
  env `PI_REVIEW_COORDINATOR_MODEL` / `PI_REVIEW_VERIFIER_MODEL`) let the
  coordinator and LLM verifier run on a stronger model while persona
  reviewers stay on the cheap `model`. Both default to the `model` input —
  existing configurations are unchanged. Setting `coordinator-model` while
  `skip-coordinator: true` logs a warning.
- **Per-model cost tables** (#47): new `cost-overrides` input (CLI
  `--cost-overrides`, env `PI_REVIEW_COST_OVERRIDES`) takes a JSON object
  mapping model ids to real prices (USD per 1M tokens). Without overrides
  every model id is billed in summaries at DeepSeek-flash rates; with
  per-role models (#44) that estimate is now explicitly configurable.
  Example: `{"glm-5.3": {"input": 0.6, "output": 2.2, "cacheRead": 0.1}}`.
  Invalid JSON is ignored with a stderr warning, never failing a run.

### Fixed

- The provider now registers every model id the run may request (per-role
  overrides and the whole `fallback-models` chain), not just the primary.
  Previously fallback attempts failed instantly with "model not found in
  provider" because pi-ai's `Models.getModel()` is a strict lookup over the
  registered list.
- **Empty-string option normalization** (#48): GitHub Actions injects every
  env var as a string, so an unset optional input used to arrive as `""` —
  not nullish — and could slip past `??` fallbacks as a blank value. All
  optional string options now collapse unset/blank/whitespace to undefined
  (extracted into the testable `src/parse-args.ts`), and an explicitly empty
  `model` fails loudly instead of silently dropping the configured primary
  model onto the fallback chain. `fallback-models: ""` keeps its documented
  meaning (disable the chain).
- **Verdict rendering for prose-style coordinators** (#53): when the
  coordinator opens with prose (no first-line keyword), the full-text
  fallback used to scan by severity order, so a persona verdict QUOTED
  mid-body outranked the coordinator's own concluding verdict — rendering
  CONDITIONAL MERGE over a "Synthesis: CAN MERGE" conclusion (dogfood
  PR #52). The fallback now takes the LAST keyword occurrence, and the
  coordinator prompt requires a machine-readable `<verdict>` tag at the
  end of the report which the parser treats as authoritative over any
  prose scan; the first-line keyword and the persona majority vote remain
  as fallbacks. Also fixed: `package.json` bin pointed at a nonexistent
  `dist/index.js`, and CI now enforces that `dist/` is committed in sync
  with `src/` (#52).

## [1.5.0] - 2026-07-16

### Added

- **Two-layer verifier** to suppress hallucinated findings (#21): rule-based
  layer checks that findings reference changed lines/files, LLM layer re-reads
  the code to confirm or demote each surviving finding. Demoted items appear in
  a collapsible section below the review.
- **Regex support in grep tool**: the `walkGrep` matcher now accepts regex
  patterns by default, with a `literal` flag for exact substring matching.
- **Cross-model fallback** (#29): when the primary model fails, the agent
  retries on a configurable comma-separated fallback list
  (`PI_REVIEW_FALLBACK_MODELS`).

### Fixed

- `parseDiffPath` handles file paths containing spaces (#25).
- `filterDiff` truncates at section boundaries and excludes build artifacts
  (`dist/`, `build/`, `*.min.js`) by default to avoid context-window blowup on
  large PRs (#28).
- `walkGrep` glob matching normalizes path separators for Windows compatibility.

## [1.4.0] - 2026-07-10

### Added

- **Inline review comments** via the GitHub Reviews API (#10): findings are
  posted as line-level review comments instead of a single wall of text.
- **Gitea platform support**: new platform adapter alongside GitHub, with
  HTTPS protocol validation for `GITEA_URL`.
- **Repository style-guide injection**: auto-detects `STYLE_GUIDE.md` or
  `.github/STYLE_GUIDE.md` and injects it into the quality persona prompt.

### Fixed

- Thread `modelId` through team mode so the correct model is used for every
  reviewer and coordinator call.
- Use CJS format for dist build to match Node.js action runner expectations.

## [1.3.0] - 2026-06-30

### Added

- **PR context injection**: reviewers now see the PR's title, body, author,
  base/head branch, changed-files list, conversation comments, formal
  reviews (APPROVE / REQUEST_CHANGES / COMMENT), and inline review comments
  — prepended to every reviewer's prompt as a `<pull_request_context>`
  block. Reviewers no longer review in a vacuum; they can read *why* the PR
  was made and what humans/bots already said about it. Modeled on opencode's
  `buildPromptDataForPR`. New action input `include-pr-context` (default
  `true`); set `false`/`0` to disable.
- **Pagination**: list endpoints follow the GitHub `Link rel=next` header up
  to 300 items per section, so >100-file PRs are no longer silently truncated.
- **Best-effort fetch**: any context-fetch failure (fork-PR 403, missing
  token, network blip) logs a warning and continues with diff-only review.
- **Self-filtering**: comments/reviews carrying the `<!-- pi-review-agent -->`
  marker are dropped before formatting, so a re-review doesn't feed the
  reviewer its own prior output.
- **Honest truncation counts**: `dropped` reflects the true total minus the
  cap; when the pagination ceiling itself is hit, the output flags
  "real total higher" so the LLM knows the count is a floor.

### Changed

- PR body is byte-capped (8 KB default) with continuation lines indented, so
  long issue templates no longer consume the context window and multi-line
  bodies stay parseable.
- PR number source unified: `index.ts` passes the already-parsed `--pr` /
  `PI_REVIEW_PR` value into the context fetch instead of re-parsing
  `GITHUB_REF`, eliminating a divergent-source footgun.

### Fixed

- `SELF_MARKER` exact match (was a prefix substring that could false-positive
  on human comments mentioning `pi-review-agent-example`).

## [1.2.0] - 2026-06-29

- diff-filter, retry, fail-on-severity (#6)
- PR comment dedup per head SHA (#7)
- configurable review output language, default 中文 (#4)
