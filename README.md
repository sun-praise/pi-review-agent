# pi-review-agent

Multi-persona PR review agent built on [Pi](https://github.com/earendil-works/pi) (earendil-works), with cross-runner session resume and correct `cache_read` accounting.

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
- [x] Verdict fallback chain (coordinator → persona severity vote)
- [x] Custom personas via `.github/reviewers/*.yaml`
- [ ] Unit tests
- [ ] Multi-instance personas (count >1 in team spec currently runs as 1)

## License

MIT
