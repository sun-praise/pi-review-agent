# pi-review-agent

Multi-persona PR review agent built on [Pi](https://github.com/earendil-works/pi) (earendil-works), with cross-runner session resume, inline review comments, and correct `cache_read` accounting.

## Why this exists

The predecessor ([opencode-actions multi-review](https://github.com/sun-praise/opencode-actions)) had a working v2 session-resume mechanism but a provider-specific bug: `tokens_cache_read` stayed 0 for OpenAI-compatible providers (litellm → DeepSeek), even though the upstream returned `prompt_tokens_details.cached_tokens`. Tracked at anomalyco/opencode#34022.

This agent sidesteps that by using `@earendil-works/pi-ai`, whose `openai-completions` parser correctly maps `cached_tokens → usage.cacheRead`.

## Verified end-to-end (CI)

| # | claim | evidence |
|---|---|---|
| 1 | DeepSeek caches by content prefix | direct + proxy curl, `cached_tokens=5888/6004` |
| 2 | litellm forwards `cached_tokens` (stream + non-stream) | curl on `llm.sun-praise.com` |
| 3 | pi-ai reads it into `usage.cacheRead` | `examples/demo-cache.ts` + live runs |
| 4 | pi-ai applies the discounted cache cost | `usage.cost.cacheRead` populated |
| 5 | Single-persona CI run | cacheRead=17536 (opencode same env: 0) |
| 6 | Team mode (3 personas + coordinator) CI run | verdict CAN MERGE, cacheRead=1024 |
| 7 | Cross-run resume via `actions/cache` | re-push: cacheRead 1024→4608 (4.5×), comment edited in place |
| 8 | PR comment posting + edit-in-place | hidden marker; `PR comment: created` then `updated` |
| 9 | Verdict fallback (coordinator odd output) | 5 scenario checks, severity tiebreak |

## Run locally

```bash
npm install

# single persona
LITELLM_API_KEY=... npx tsx src/index.ts \
  --pr 123 --diff-file ./diff.txt --persona quality

# team mode (parallel personas + coordinator)
LITELLM_API_KEY=... npx tsx src/index.ts \
  --pr 123 --diff-file ./diff.txt --team "quality:1,security:1,performance:1"

# cache demo (proves pi-ai surfaces DeepSeek cache hits)
LITELLM_API_KEY=... npm run demo:cache
```

## Gitea Support

pi-review-agent now supports Gitea in addition to GitHub. The platform is auto-detected from environment variables, or can be explicitly set via `--platform`.

### Gitea Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `GITEA_URL` | Gitea instance URL (e.g., `https://gitea.example.com`) | Yes |
| `GITEA_TOKEN` | Gitea API token with repository access | Yes |
| `GITEA_REPOSITORY` | Repository in `owner/repo` format | Yes |
| `GITEA_PR_NUMBER` | Pull request number | Yes (or use `--pr`) |

### Run with Gitea (CLI)

```bash
# Auto-detect from environment
export GITEA_URL=https://gitea.example.com
export GITEA_TOKEN=your_token
export GITEA_REPOSITORY=owner/repo
export GITEA_PR_NUMBER=123

LITELLM_API_KEY=... npx tsx src/index.ts \
  --diff-file ./diff.txt --team "quality:1,security:1"

# Explicit platform
LITELLM_API_KEY=... npx tsx src/index.ts \
  --platform gitea \
  --gitea-url https://gitea.example.com \
  --gitea-token your_token \
  --pr 123 --diff-file ./diff.txt --persona quality
```

### Gitea Actions Workflow

```yaml
name: AI Code Review
on:
  pull_request:
    types: [opened, synchronize]

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Get PR diff
        id: diff
        run: |
          git diff origin/${{ github.base_ref }}...HEAD > /tmp/diff.txt
          
      - name: Run AI Review
        env:
          GITEA_URL: ${{ github.server_url }}
          GITEA_TOKEN: ${{ secrets.GITEA_TOKEN }}
          GITEA_REPOSITORY: ${{ github.repository }}
          GITEA_PR_NUMBER: ${{ github.event.number }}
          LITELLM_API_KEY: ${{ secrets.LITELLM_API_KEY }}
          LITELLM_URL: ${{ secrets.LITELLM_URL }}
        run: |
          npx tsx src/index.ts \
            --diff-file /tmp/diff.txt \
            --team "quality:1,security:1"
```

### Platform Detection Priority

1. `--platform` CLI argument (explicit)
2. `GITEA_URL` or `GITEA_TOKEN` environment variables
3. `GITHUB_REPOSITORY` or `GITHUB_TOKEN` environment variables
4. Error if none detected

## GitHub Action

Single-persona mode:

```yaml
- uses: sun-praise/pi-review-agent@v1.0.0
  with:
    persona: quality
    litellm-url: ${{ secrets.LITELLM_URL }}
    litellm-api-key: ${{ secrets.LITELLM_API_KEY }}
```

Team mode (recommended — runs N personas in parallel + a coordinator that synthesizes a single verdict, and posts a review comment to the PR):

```yaml
- uses: sun-praise/pi-review-agent@v1.0.0
  with:
    team: "quality:1,security:1,performance:1,architecture:1,regression-test:1,test-value:1"
    litellm-url: ${{ secrets.LITELLM_URL }}
    litellm-api-key: ${{ secrets.LITELLM_API_KEY }}
```

The action:
- detects the PR number from `GITHUB_REF`
- fetches the diff via `gh pr diff` (falls back to the GitHub API)
- restores the per-PR session via `actions/cache` so re-pushes continue the session
- writes a cost table to `$GITHUB_STEP_SUMMARY` (per-persona, with cacheRead surfaced)
- emits `verdict`, `cacheRead`, `totalCost` as step outputs
- posts a single PR comment (edited in place across re-pushes via a hidden marker)

`pull-requests: write` permission is required for comment posting.

## Install via agent skill

This repo ships an installer skill ([`skills/setup-pi-review/`](./skills/setup-pi-review/)) discoverable by [`npx skills`](https://github.com/vercel-labs/skills). An agent loaded with the skill (Claude Code, Cursor, etc.) can set pi-review-agent up for any repository via natural language — it generates the workflow YAML, points you to the secrets, and reminds you of the required permissions.

```bash
# list available skills in this repo
npx skills add sun-praise/pi-review-agent --list

# install into the current project (creates .claude/skills/setup-pi-review/)
npx skills add sun-praise/pi-review-agent

# install globally (all sessions)
npx skills add sun-praise/pi-review-agent --global

# install only this one skill
npx skills add sun-praise/pi-review-agent@setup-pi-review
```

After install, restart your agent session and ask it to set up pi-review-agent in the target repo. The skill walks through: workflow YAML generation, secrets (`LITELLM_URL`, `LITELLM_API_KEY`), `pull-requests: write` permission, and post-install verification (cacheRead > 0).

Migration from opencode-actions/multi-review is handled by the same skill — mention "migrate from opencode" and it follows the drop-in path.

### Custom personas

Drop `.yaml`/`.yml` files in `<repo>/.github/reviewers/` with `name` + `prompt` fields. They override built-ins of the same name and add new ones (format mirrors opencode-actions for drop-in compatibility).

## Status

- [x] pi-ai provider (litellm → deepseek) with correct cacheRead
- [x] Agent-based review with read + grep tools
- [x] JSONL session persistence + cross-runner resume
- [x] GitHub Action wrapper (composite, bundled dist)
- [x] Dogfood workflow self-reviewing PRs
- [x] Multi-persona + coordinator orchestration
- [x] PR comment posting (create + edit-in-place)
- [x] Inline review comments via GitHub Reviews API (summary/comment fallback)
- [x] Verdict fallback chain (coordinator → persona severity vote)
- [x] Custom personas via `.github/reviewers/*.yaml`
- [ ] Unit tests
- [ ] Multi-instance personas (count >1 in team spec currently runs as 1)

## License

MIT
