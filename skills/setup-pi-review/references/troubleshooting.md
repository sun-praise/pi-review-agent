# Troubleshooting

## cacheRead is 0 in the step summary

Expected: non-zero on every run (even first run, because the system prompt alone exceeds DeepSeek's 256-token cache threshold). If it's 0:

1. **Check the upstream actually returns cached_tokens**:
   ```bash
   curl -sS "${LITELLM_URL}/v1/chat/completions" \
     -H "Authorization: Bearer ${LITELLM_API_KEY}" \
     -H "Content-Type: application/json" \
     -d '{"model":"deepseek-v4-flash","messages":[{"role":"system","content":"<long repeated prefix ~6k tokens>"},{"role":"user","content":"hi"}],"max_tokens":5}' \
     | python3 -c 'import sys,json; u=json.load(sys.stdin).get("usage",{}); print(u)'
   ```
   Look for `prompt_tokens_details.cached_tokens` or `prompt_cache_hit_tokens`. If absent, the upstream isn't caching (DeepSeek TTL expired, or the endpoint isn't actually DeepSeek).

2. **Diff too small**: DeepSeek cache threshold is ~256 tokens of shared prefix. If your PR touches one tiny file, the system prompt alone may not clear it. Run a second time — the accumulated history may push it over.

3. **TTL expiry**: DeepSeek cache lives hours. If the previous run was >6h ago, the cache expired. No error, just full price that run.

4. **Wrong model id**: if `model:` is set to something the proxy doesn't route to DeepSeek, caching won't apply. Stick to `deepseek-*` models.

## PR comment not posted

Symptoms: review runs but no comment appears on the PR.

1. **Missing permission**: the job needs `pull-requests: write`. Check the workflow yaml:
   ```yaml
   permissions:
     pull-requests: write
   ```

2. **Token scope**: if using a custom token (not `${{ github.token }}`), it needs `issues: write` scope (PR comments are technically issue comments).

3. **Fork PRs**: `${{ github.token }}` is read-only on PRs from forks. Either restrict the workflow to same-repo PRs, or use a PAT.

4. **Silent failure**: pi-review-agent never fails the build because comment posting failed (it logs to stderr and continues). Check the job log for `postPrComment: failed (...)` lines.

## "no diff source" error

Means none of `--diff-file`, `PI_REVIEW_DIFF_FILE`, or `PI_REVIEW_DIFF` was set. Usually the "Fetch PR diff" step failed — check that `gh pr diff` works in the runner, or that the GitHub API fallback got the diff.

## Verdict is UNKNOWN

Means:
1. Coordinator didn't put `CAN MERGE` / `CONDITIONAL MERGE` / `CANNOT MERGE` in its output, AND
2. No persona's first line matched either

Usually a model-output format issue. Check the coordinator output in the step summary. If it's consistently malformed, consider `skip-coordinator: true` (verdict falls back to persona severity vote).

## Build / install issues

These affect development of pi-review-agent itself, not usage:

- **`Cannot find module '@earendil-works/pi-ai'`** in the runner: the dist bundle wasn't rebuilt. The action ships `dist/index.cjs` bundled via tsup — if src changed but dist wasn't rebuilt + committed, the action runs stale code.
- **TS errors about `Promise.withResolvers`**: tsconfig needs `"lib": ["ES2024"]`.
- **js-yaml `No matching export ... default`**: use `import { load as yamlLoad } from "js-yaml"`, not `import yaml from "js-yaml"`.
