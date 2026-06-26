# pi-review-agent

Multi-persona PR review agent built on [Pi](https://github.com/earendil-works/pi) (earendil-works), with cross-runner session resume and correct `cache_read` accounting.

## Why this exists

The predecessor ([opencode-actions multi-review](https://github.com/sun-praise/opencode-actions)) had a working v2 session-resume mechanism but a provider-specific bug: `tokens_cache_read` stayed 0 for OpenAI-compatible providers (litellm → DeepSeek), even though the upstream returned `prompt_tokens_details.cached_tokens`. Tracked at anomalyco/opencode#34022.

This agent sidesteps that by using `@earendil-works/pi-ai`, whose `openai-completions` parser correctly maps `cached_tokens → usage.cacheRead` (verified end-to-end: `cacheRead=5888` for a warmed prefix).

## Verified end-to-end

| # | claim | evidence |
|---|---|---|
| 1 | DeepSeek caches by content prefix | direct + proxy curl, `cached_tokens=5888/6004` |
| 2 | litellm forwards `cached_tokens` (stream + non-stream) | curl on `llm.sun-praise.com` |
| 3 | pi-ai reads it into `usage.cacheRead` | `examples/demo-cache.ts` |
| 4 | pi-ai applies the discounted cache cost | `usage.cost.cacheRead` populated |

## Run

```bash
npm install
LITELLM_API_KEY=... npm run demo:cache
# run 1: resumed=false, cacheRead=0 (cold)
# run 2: resumed=true,  cacheRead>0 (warm prefix hit), cost drops
```

## Status

Scaffold. Roadmap:

- [ ] Swap `runReview` to use `@earendil-works/pi-agent-core` `Agent` for full assistant-message replay and tool calling (grep/read).
- [ ] 6-persona + coordinator orchestration.
- [ ] GitHub Action wrapper.
- [ ] CI (unit tests; cache-read regression test).

## License

MIT
