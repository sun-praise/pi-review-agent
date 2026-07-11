# Inputs reference

All inputs are optional unless noted. Defaults shown.

## Connection

| Input | Default | Description |
|---|---|---|
| `litellm-url` | `""` (required) | LiteLLM proxy base URL. Trailing `/v1` optional — normalized internally. |
| `litellm-api-key` | `""` (required) | API key for the proxy. |
| `model` | `"deepseek-v4-flash"` | Model id to request. Cost/compat stay DeepSeek-shaped; works for any `deepseek-*` behind the same proxy. |

## Review mode

| Input | Default | Description |
|---|---|---|
| `team` | `""` | Multi-persona spec `"quality:1,security:1,..."`. When set, runs team mode. |
| `persona` | `"quality"` | Single-persona name. Ignored when `team` is set. |
| `skip-coordinator` | `"false"` | Skip coordinator synthesis (team mode only). Verdict falls back to persona severity vote. |

Built-in personas: `quality`, `style`, `security`, `performance`, `architecture`, `regression-test`, `test-value`.

Count >1 is accepted (e.g. `quality:2`) but currently runs as 1 — kept for spec compatibility with opencode-actions.

## Style-guide

| Input | Default | Description |
|---|---|---|
| `style-guide` | `""` | Explicit path to a repository style-guide file. When empty, the agent auto-detects `STYLE_GUIDE.md`, `.github/STYLE_GUIDE.md`, `docs/style-guide.md`, or `.github/style-guide.md`. The loaded guide is appended to the prompts of the `style` and `quality` personas and any custom persona with `use-style-guide: true`. |

## PR context

| Input | Default | Description |
|---|---|---|
| `github-token` | `${{ github.token }}` | Token for fetching diff + posting comment. Needs `pull-requests: write`. |
| `pr` | `""` | PR number. Auto-detected from `GITHUB_REF` on `pull_request` events. Set explicitly for `workflow_dispatch`. |
| `working-directory` | `""` | Repo checkout path for read/grep tools. Defaults to `github.workspace`. |

## Session resume

| Input | Default | Description |
|---|---|---|
| `sessions-root` | `""` | Directory for per-PR session JSONL. Defaults to `${RUNNER_TEMP}/.pi-review-sessions`. Override if you skip `actions/cache` (not recommended — breaks cross-run resume). |

The action uses `actions/cache@v4` with key `pi-review-session-<repo>-<pr>-<run_id>` and restore-key prefix `pi-review-session-<repo>-<pr>-`. This is what makes re-push continue the prior session.

## Outputs

| Output | Description |
|---|---|
| `verdict` | `CAN MERGE` / `CONDITIONAL MERGE` / `CANNOT MERGE` / `UNKNOWN`. Team mode: coordinator verdict (persona severity vote as fallback). Single mode: reviewer's first line. |
| `cacheRead` | Total cache-hit tokens across all reviewers + coordinator. Non-zero = upstream cache hit → discounted billing. |
| `totalCost` | Total USD cost across all reviewers + coordinator. |

Reference as `steps.<step-id>.outputs.<name>` (give the step an `id:`).
