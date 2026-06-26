# Migrating from opencode-actions/multi-review

If the target repo already uses `sun-praise/opencode-actions/multi-review`, pi-review-agent is a near drop-in replacement that fixes the cache_read=0 problem.

## Why migrate

opencode's `tokens_cache_read` stays 0 for OpenAI-compatible providers (litellm → DeepSeek) even when the upstream returns `prompt_tokens_details.cached_tokens`. Result:
- Cost tables report full price for tokens actually served from cache
- Resume-saves-cost claim is unverifiable
- The whole v2 session-resume feature is cost-negative (resume ≈ fresh cost, sometimes more)

pi-review-agent uses `@earendil-works/pi-ai`, whose `openai-completions` parser correctly maps `cached_tokens → usage.cacheRead`. Same env, cacheRead non-zero. Tracked at anomalyco/opencode#34022.

## Compatibility matrix

| Concept | opencode multi-review | pi-review-agent |
|---|---|---|
| Reviewer personas | `.github/reviewers/*.yaml` | Same format, drop-in |
| Team spec | `default-team: "quality:1,security:1"` | `team: "quality:1,security:1"` |
| Built-in personas | 8 (quality/security/perf/arch/regression/feature-missing/test-value/spec-coverage) | 6 (quality/security/perf/arch/regression/test-value) — feature-missing/spec-coverage not built in; add via custom yaml if needed |
| Provider | litellm / zhipu / minimax / deepseek-direct / ... | LiteLLM proxy (OpenAI-compatible) → typically DeepSeek |
| Session resume | export/import bundle (opencode CLI) | JSONL files + actions/cache |
| Cache accounting | 0 for litellm (bug) | correct (pi-ai reads cached_tokens) |
| PR comment | yes | yes (edit-in-place via marker) |

## Migration steps

1. **Keep the persona yaml files** if you have custom ones in `.github/reviewers/`. They work as-is.

2. **Replace the workflow**:

   Before (opencode):
   ```yaml
   - uses: sun-praise/opencode-actions/multi-review@v4.1.0
     with:
       model: "litellm/deepseek-v4-flash"
       default-team: "quality:1,security:1,performance:1"
       github-token: ${{ secrets.GITHUB_TOKEN }}
       litellm-url: ${{ secrets.LITELLM_URL }}
       litellm-api-key: ${{ secrets.LITELLM_API_KEY }}
   ```

   After (pi-review-agent):
   ```yaml
   - uses: sun-praise/pi-review-agent@v1
     with:
       team: "quality:1,security:1,performance:1"
       litellm-url: ${{ secrets.LITELLM_URL }}
       litellm-api-key: ${{ secrets.LITELLM_API_KEY }}
   ```

   Differences:
   - `default-team` → `team`
   - `model` input: pi-review-agent uses `deepseek-v4-flash` directly (no `litellm/` prefix); change via `model:` input if your proxy uses a different name
   - No `install-url` / `version` / `setup-opencode` step — pi-review-agent ships a single bundled `dist/index.cjs`, no opencode CLI install needed

3. **Secrets stay the same**: `LITELLM_URL`, `LITELLM_API_KEY`. No new secrets required.

4. **Permissions**: both need `pull-requests: write` for comment posting. No change.

5. **First PR after migration**: check the step summary. `cacheRead` should be non-zero (opencode was always 0). If it's still 0, see [troubleshooting.md](troubleshooting.md).

## What doesn't carry over

- opencode-specific inputs: `reasoning-effort`, `enable-thinking`, `language`, `diff-exclude`, `diff-max-size-kb`, `fail-on-severity`, `extra-env` — pi-review-agent doesn't have these. Most are either handled internally (diff truncation is implicit; thinking follows the model's default) or have simpler equivalents (`fail-on-severity` → use the `verdict` output with a gate step, see workflow-template.md).
- opencode session bundles (the v2 export/import cache) — pi-review-agent uses its own JSONL sessions, stored via actions/cache. Old opencode bundles are not migrated and don't need to be.
