# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
