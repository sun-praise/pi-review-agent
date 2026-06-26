# pi-review-agent

Multi-persona PR review agent built on [Pi](https://github.com/earendil-works/pi) (earendil-works), with cross-runner session resume and correct `cache_read` accounting.

## Why this exists

The predecessor ([opencode-actions multi-review](https://github.com/sun-praise/opencode-actions)) had a working v2 session-resume mechanism but a provider-specific bug: `tokens_cache_read` stayed 0 for OpenAI-compatible providers (litellm → DeepSeek), even though the upstream returned `prompt_tokens_details.cached_tokens`. Tracked at anomalyco/opencode#34022.

This agent sidesteps that by using `@earendil-works/pi-ai`, whose `openai-completions` parser correctly maps `cached_tokens → usage.cacheRead`.

## Verified end-to-end

| # | claim | evidence |
|---|---|---|
| 1 | DeepSeek caches by content prefix | direct + proxy curl, `cached_tokens=5888/6004` |
| 2 | litellm forwards `cached_tokens` (stream + non-stream) | curl on `llm.sun-praise.com` |
| 3 | pi-ai reads it into `usage.cacheRead` | `examples/demo-cache.ts` + live runs |
| 4 | pi-ai applies the discounted cache cost | `usage.cost.cacheRead` populated |
| 5 | Agent-based resume reuses prior session | replayed transcript → agent says "already reviewed above" |
| 6 | Single-file `dist/index.cjs` runs with no `npm install` | tsup CJS bundle, 6.17 MB |

## Run locally

```bash
npm install
LITELLM_API_KEY=... npm run demo:cache
# run 1: resumed=false
# run 2: resumed=true, cacheRead>0, agent recognizes the prior turn
```

## GitHub Action

```yaml
- uses: sun-praise/pi-review-agent@main
  with:
    persona: quality
    litellm-url: ${{ secrets.LITELLM_URL }}
    litellm-api-key: ${{ secrets.LITELLM_API_KEY }}
```

The action:
- detects the PR number from `GITHUB_REF`
- fetches the diff via `gh pr diff` (falls back to the GitHub API)
- restores the per-PR session via `actions/cache` so re-pushes continue the session
- writes a cost table to `$GITHUB_STEP_SUMMARY` (with cacheRead surfaced)
- emits `cacheRead`, `costTotal`, `resumed`, `sessionId` as step outputs

## Status

- [x] pi-ai provider (litellm → deepseek) with correct cacheRead
- [x] Agent-based review with read + grep tools
- [x] JSONL session persistence + cross-runner resume
- [x] GitHub Action wrapper (composite, bundled dist)
- [x] Dogfood workflow self-reviewing PRs
- [ ] 6-persona + coordinator orchestration
- [ ] Unit tests + cache-read regression test
- [ ] PR comment posting

## License

MIT

## Resume verification

Re-pushing to a PR continues the prior session. The second run should show
`resumed=true` and the agent recognizing the prior turn.
