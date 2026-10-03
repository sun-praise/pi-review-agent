# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.11.0] - 2026-10-03

### Added

- **`max-reviews-per-pr`** (#84): configurable cap on the total number of
  review rounds per PR (`max-reviews-per-pr` input /
  `PI_REVIEW_MAX_REVIEWS_PER_PR` env / `--max-reviews-per-pr` CLI).
  **Behavior change: the default is `5`** — every PR's token spend is
  bounded out of the box; explicit `0` restores unlimited. Each run that
  dispatches a review bumps a counter file
  (`<sessions-root>/<pr>/review-count.json`) that rides the same per-PR
  `actions/cache` entry as the resume JSONL, so the count persists across
  runs and never leaks between PRs. Once the counter reaches the limit,
  later runs skip the review entirely — exit 0, a step-summary note, and no
  PR-comment update — so the workflow stays green while token spend stops.
  Headless json mode keeps its one-JSON-document stdout contract on a skip:
  the payload carries `skipped: {reason: "review-limit", completed, limit}`
  with empty findings and zero usage (found blocking by dogfood after the
  severity-parser fix let the gate read findings again). A skipped run is
  never silent: `::warning::` annotation, `skipped`/`completed`/`limit`
  step outputs (new `skipped` action output), and a step-summary note —
  fail-on-severity consumers that must not pass unreviewed should gate on
  `skipped` (this repo's dogfood pins `max-reviews-per-pr: "0"`).
  Re-runs count as
  reviews (they spend tokens); skipped runs never count. The counter is a
  fact record, not a ban: raising the limit resumes reviewing, deleting
  the file resets it, and a cache eviction resets it to 0 — every
  degradation fails toward "review again", never toward silently stopping.

### Fixed

- **dogfood gate red on a ✅ CAN MERGE review** (observed on PR #85, run
  37086811185): the output-format prompts ask for sections by bare name
  ("Then 'Blocking Issues' …"), but `parseSeverity` only recognized
  `###`-prefixed headings — a coordinator that complied literally (bare
  `Blocking Issues` / `Warnings` lines) produced `fallback: true`, and the
  armed `fail-on-severity` gate failed closed (exit 1) while the lenient
  verdict path posted ✅ CAN MERGE. The heading matcher now accepts every
  shape the prompts can legitimately produce — bare, bold, colon-headed
  (including `'Blocking Issues: None'` and `阻塞项：无` single-line forms),
  any `#`-depth prefix, emoji and bold in either order, bilingual keywords,
  the legacy ` / suffix` — with whole-line anchoring so prose never
  matches. `SECTION_RE` and the section-body terminator are now derived
  from ONE source pattern (same case-insensitivity): hand-written
  separately they drifted and let one bucket absorb the next section's
  items, double-counting them into the gate (found by this PR's own dogfood
  review); a shape battery pins the recognition⇒termination invariant in
  both orientations. Section bodies end EXACTLY at recognized keyword
  headings (any `#`-depth) and nothing else — any depth-based truncation
  dropped items grouped under non-keyword sub-headings (`## Issue 1: …` in
  dogfood round 2, the legacy `### ` rule in round 3), parsing `CANNOT
  MERGE` + real blockers as blockingCount=0 and exiting green; the residual
  over-count direction (loose items after a mid-section heading join the
  current bucket) fails toward red, which is the direction this gate is
  allowed to err in. A leading `#86` issue reference terminates nothing.
  `extractDecision` additionally honors the `<verdict>` tag (authoritative
  per the coordinator prompt, mirroring `resolveVerdict`) so a coordinator
  opening with prose no longer yields UNKNOWN → fail-closed red while the
  comment says ✅. Fail-closed for genuinely structureless output is
  unchanged and still tested.

## [1.10.1] - 2026-09-27

### Fixed

- **MiMo consumers 400 on every request — v1.10.0 pulled within 15 minutes**
  (ops issue Svtter/ops#126): pi-ai >= 0.87 sends
  `max_completion_tokens = model.maxTokens` by default (0.80 omitted it), so
  the provider's historical `maxTokens: 384000` scaffold metadata — inert
  under 0.80 — went on the wire and hit MiMo's 131072 completion cap on
  every request, breaking all MiMo consumers ~100s after the `v1` moving
  tag moved. The fix omits the parameter for every family
  (`maxTokens: MAX_TOKENS_OMIT` sentinel; each upstream applies its own
  default ceiling — MiMo v2.6 defaults to its full 131072), the pi deps are
  pinned to exact 0.87.1 so the falsy-skip contract only moves through a
  deliberate upgrade, and the dogfood workflow becomes a real gate: single
  mimo-v2.6-flash leg, `fail-on-severity: "blocking"`, no fallback,
  `concurrency` group, 900s timeout headroom, and a fork-PR guard.

### Added

- **Incremental review**: on a re-run of the same PR, the review payload is
  the delta since the last reviewed commit instead of the full PR diff. The
  anchor is the hidden sha fingerprint (`<!-- pi-review-agent-sha:... -->`)
  already embedded in every standing comment — no new state. The delta is
  computed with `git diff <anchor>..<head>` from the object database (never
  the working tree, so a stale checkout cannot skew it; missing commits are
  fetched from origin first), with the GitHub compare API as fallback. The
  previous round's summary is injected into every reviewer prompt (markers
  stripped, capped at 6000 chars) so unresolved findings ride along, and the
  verdict is judged on the PR's cumulative state. The verifier keeps the
  full diff as its changed-lines baseline so a carry-forward finding on a
  line an earlier round changed is not demoted as a hallucination.
  Anchors are identity-checked (agent marker + self authorship: GitHub does
  an exact login match when GET /user resolves and requires a Bot-type
  author when it 403s — the default github.token is an installation token;
  Gitea requires the login match and fails closed when its token's identity
  cannot be resolved) so a copied fingerprint in someone else's comment
  cannot steer the delta;
  non-ancestor anchors (rebase/force-push) fall
  back to a full review via a `merge-base --is-ancestor` gate — the compare
  fallback is deliberately skipped there, since three-dot diff would
  silently miss reverted commits. Empty deltas (rebase squash, amend-only)
  also fall back to a full review instead of crashing the run on the
  falsy diff-source check, and attempted-but-failed deltas record their
  reason in the stats event (`incrementalFallback`) alongside
  `incrementalSince`. Anchor listings paginate (GitHub via the Link
  header's last page; Gitea via X-Total-Count) so the newest anchor is
  reachable on busy PRs. Fail-open at every layer: first review, no
  checkout, API failure → full review, exactly the previous behavior. Opt-out via `incremental: false` (`PI_REVIEW_INCREMENTAL=0`);
  on-demand full re-review via `force-full: true` (`PI_REVIEW_FORCE_FULL=1`,
  e.g. wired to a `full-review` label). Stats events carry a new additive
  `incrementalSince` field (null = full review).

## [1.10.0] - 2026-09-27

> Pulled from the `v1` tag ~15 minutes after release (max_completion_tokens
> breakage, see 1.10.1). Consumers that resolved `@v1` during that window
> were affected; `v1` points at 1.9.0 until 1.10.1.

### Changed

- **Thinking is now enabled by default** (#80): reviewer personas and the
  verifier construct their Agent with `thinkingLevel: "high"` instead of
  `"off"`. On the wire (verified against a capture server through the real
  provider config) this sends `thinking: {"type":"enabled"}` for
  deepseek-format models instead of an explicit `{"type":"disabled"}` —
  previously production was deterministically *not* thinking. Multi-turn
  tool calls are covered: the provider already sets
  `requiresReasoningContentOnAssistantMessages`, so assistant messages
  carrying `tool_calls` round-trip `reasoning_content` (MiMo returns 400
  without it), and resumed sessions backfill `reasoning_content: ""` on
  older transcripts. Expect per-persona completion tokens and elapsed time
  to rise; the 600s inner-SDK timeout (#72) and the verifier's 120s budget
  are now under more pressure on large-context PRs.
- **pi runtime upgraded: `@earendil-works/pi-ai` + `pi-agent-core`
  0.80.2 → 0.87.1** (#79; both move together — version-locked monorepo).
  Zero source changes were needed; the 0.84–0.87 breaking changes touch
  APIs this repo doesn't use. What the bump buys: transient DNS failures
  (`getaddrinfo`/`ENOTFOUND`/`EAI_AGAIN`) now trigger automatic assistant
  retries instead of surfacing as stream errors; unmapped terminal stop
  reasons surface as provider errors instead of masquerading as successful
  stops (the #59 "stale content as success" class); provider stream
  event-sequence and tool-call delta fixes (v0.85). The
  `thinkingFormat: "deepseek"` branch is byte-identical between versions —
  no wire change from the bump itself. `dist/index.cjs` shrinks 6.9MB →
  1.7MB because the old bundle inlined pi's built-in model catalogs, which
  0.87's package layout tree-shakes away (see LRN-20260927-001).

## [1.9.0] - 2026-09-23

### Fixed

- **grep now searches committed build artifacts and reports non-ASCII paths
  literally** (#76): the reviewer/verifier `grep` tool walked the tree with a
  hardcoded IGNORE list (`dist/`, `build/`, `vendor/`…), so in repositories
  that commit their build output — this one runs `node dist/index.cjs` from
  git — grep evidence about the bundle was silently empty, and a reviewer
  could turn "the tool refused to look" into a confident "verified absent"
  blocking finding. The tool now shells out to
  `git -c core.quotepath=false grep --untracked` (same approach as
  alibaba/open-code-review): the search range is defined by git itself —
  tracked files plus untracked non-ignored files, `.gitignore` honored — and
  non-ASCII paths come back literally instead of octal-escaped (#74 family).
  Truncated results now lead with a `Note:` line reporting the true match
  and file totals (all lines are counted, only rendering is capped); a
  timeout or git failure surfaces as an actionable note instead of an empty
  result. Non-git directories keep the legacy walker as a fallback;
  git-without-PCRE, missing git, and buffer overflow each classify into
  their own fallback or actionable note.

## [1.8.1] - 2026-09-23

### Added

- **Headless JSON mode** (`--format json` / `PI_REVIEW_FORMAT`): runs the
  reviewer without a PR number, platform env vars, or PR-comment posting,
  and emits one machine-readable payload (stdout, or `--output` /
  `PI_REVIEW_OUTPUT`) with the verified line-pinned `comments`, the
  verifier summary, verdict/severity, and per-persona + aggregate usage
  (tokens, cacheRead, cost) — built for evaluation harnesses such as
  aacr-bench, where an instance is a repo checkout plus a commit-pair diff.
  `--session-key` (`PI_REVIEW_SESSION_KEY`) replaces the PR number as the
  session identity; the value is sanitized into a safe path segment with a
  deterministic `key-<hash>` fallback for traversal-shaped inputs (`..`,
  `.`, empty — directory escape is impossible and the final path is
  containment-asserted), and a random `bench-*` key (resolved at parse
  time, keeping `CliOptions` immutable) isolates keyless json runs. The
  payload echoes the sanitized directory name actually used on disk, adds
  `coordinatorError` to distinguish a skipped synthesis from a crashed
  one, and reuses orchestrate's totals so JSON and PR-comment renderings
  can't drift. The fail-on-severity exit gate is disabled in json mode so
  a harness never reads `CANNOT MERGE` as a process failure; a failed
  `--output` write falls back to stdout with a failing exit code.
  Related-files context and opt-in stats still work headless (repository
  falls back to env or `"local"`).

### Fixed

- **Non-ASCII filenames no longer false-positive the stale-tree guard**
  (#74): git (and `gh pr diff` / the GitHub `.diff` API) quotes non-ASCII
  paths and escapes every non-ASCII byte as 3-digit octal
  (`core.quotepath`, on by default). `parseDiffPath()` returned the quoted
  segment verbatim, so a Chinese-named file the PR adds never matched its
  on-disk UTF-8 name — the #67 guard aborted a perfectly correct head
  checkout (first seen on hugo-blog PR #134), and `changed-lines`
  inline-comment keys / `diff-filter` mismatched the same way. The quoted
  branch now decodes `\"` / `\\` literally and `\NNN` into a byte buffer
  decoded as UTF-8 once at the end (one escape is a single byte of a
  multi-byte character), and its a-side regex takes `(?:[^"\\]|\\.)*` so an
  embedded `\"` no longer truncates the match.

## [1.8.0] - 2026-09-10

### Added

- **Per-run statistics events** for cross-repo dashboards: every completed
  review now records one stats event — review count, per-persona and total
  token usage (`input`/`output`/`cacheRead`/`cacheWrite`), cost, verdict,
  severity, and duration. The event is appended to
  `<sessions-root>/stats.jsonl` and, when the new `stats-url` input
  (`PI_REVIEW_STATS_URL` / `--stats-url`) is set, POSTed to a central
  dashboard (`pi-review-dashboard`, separate project) with optional
  `stats-token` bearer auth. Emission is fail-open — a stats problem never
  fails a review — and events are deduplicated downstream by
  `(platform, repository, runId, attempt)` so CI re-runs count once.
  Statistics is opt-in: OFF by default — `stats-enabled: true`
  (`PI_REVIEW_STATS_ENABLED=1`) enables the local record, and a set
  `stats-url` additionally ships each event; a `stats-url` without the
  switch warns on stderr instead of silently doing nothing.

### Fixed

- **Stale-tree guard: fail closed when the workspace provably isn't the PR
  head** (#67, first half): if files the diff marks `new file mode` are
  missing under the working directory, the run now aborts with actionable
  guidance instead of silently reviewing a stale tree. Root cause of #67:
  a self-hosted review workflow without `actions/checkout` reuses the
  previous job's checkout, so reviewers grep an old tree, the coordinator
  synthesizes a verdict from stale code facts, and the verifier demotes
  the findings only after the verdict was already computed (documented on
  review-server-neo PR #15). A merge-commit checkout contains added files
  too, so correct configurations are unaffected; diffs with no additions
  can't be checked this way and stay unguarded by design.

- **Caution banner when the verdict rests entirely on demoted findings**
  (#67, second half): the verifier runs after the coordinator, so a
  CONDITIONAL/CANNOT MERGE could stand on blocking issues that ALL failed
  independent verification (documented on review-server-neo PR #15 — 0/3
  verified, verdict unchanged). When every blocking inline finding was
  demoted and none verified, both posted bodies (standing comment + review
  digest) now carry an "Unverified verdict" banner telling the reader the
  Blocking Issues may rest on wrong code facts and to re-review before
  merging. Verdict and `fail-on-severity` semantics are deliberately
  unchanged: demotion proves a finding unverifiable, not the PR mergeable —
  downgrading to CAN MERGE would be fail-open, and UNKNOWN would trip the
  armed gate on evidence we don't have.

## [1.7.1] - 2026-09-07

### Fixed

- **Review and top-level comment no longer duplicate the same body** (#62):
  since 1.7.0 both surfaces received the identical full summary, so every run
  with inline findings put two verbatim copies at the top of the PR. The
  review now carries only a slim verdict digest (verdict, verification
  roll-up, fail-closed banner, pointer to the standing comment); the
  top-level comment keeps the full synthesis. Degraded runs (Reviews API
  rejected the batch, Gitea's single-comment flow) still land the full body —
  slim is only safe when the standing comment is guaranteed to follow. The
  full body is also archived in the step summary per run.

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
