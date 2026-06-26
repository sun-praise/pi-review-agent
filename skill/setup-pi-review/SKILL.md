---
name: setup-pi-review
description: Install sun-praise/pi-review-agent GitHub Action into a user's repository. Triggers on "安装 pi-review-agent", "setup pi review", "配置 pi-review", "add pi-review-agent", "multi-persona AI review setup", or any request to add the pi-review-agent GitHub Action for automated PR code review. Covers workflow YAML generation, secrets (LITELLM_URL, LITELLM_API_KEY), permissions (pull-requests: write), and team/persona configuration.
---

# Setup pi-review-agent

Configure `sun-praise/pi-review-agent` GitHub Action for a user's repository.
The action runs multi-persona AI code review on PRs, with cross-runner session
resume and correct `cache_read` accounting (surfaces DeepSeek prompt-cache hits
that opencode's OpenAI-compatible path drops).

## When to use

User wants automated AI code review on PRs in their repo, specifically:
- mentions pi-review-agent, pi review, or asks to "add AI review"
- wants multi-persona review (quality + security + performance + ...)
- mentions LiteLLM + DeepSeek for review
- is migrating off opencode-actions/multi-review because of the cache_read=0 issue

Do NOT use for:
- opencode-actions/multi-review setup → use the `setup-ci` skill instead
- generic "AI review" with no provider preference → ask first

## Workflow

1. **Identify target repo**: confirm with the user which repo gets the action. If running inside a repo, that's the default. Check `git remote -v` to confirm origin.

2. **Check for existing review setup**: look for `.github/workflows/*.yml` mentioning review/multi-review/opencode. If opencode multi-review is present, flag the migration path (see references/migration-from-opencode.md).

3. **Choose mode** (ask the user if unclear):
   - **Team mode** (recommended): multiple personas + coordinator, posts a PR comment
   - **Single-persona mode**: one reviewer, output to step summary only

4. **Generate workflow YAML**: see [references/workflow-template.md](references/workflow-template.md). Default to team mode with `quality:1,security:1,performance:1`.

5. **Set secrets**: the user must add two repository secrets (you cannot do this for them — point them to the URL):
   - `LITELLM_URL` — LiteLLM proxy base URL (e.g. `https://llm.example.com`, with or without `/v1`)
   - `LITELLM_API_KEY` — LiteLLM API key

   Direct URL: `https://github.com/<owner>/<repo>/settings/secrets/actions`

6. **Permissions**: the workflow job needs `pull-requests: write` to post the review comment. The template includes this; if the user has an existing workflow, remind them to add it.

7. **Verify**: after the first PR, check the run — `cacheRead` should be non-zero in the step summary (opencode same env reports 0). See [references/troubleshooting.md](references/troubleshooting.md) if it isn't.

## Version pinning

Stable references:
- `@v1` — moving tag, follows latest v1.x.x (recommended for users)
- `@v1.0.2` — precise version, for locked CI

Do NOT recommend `@main` for production workflows (unstable).

## Custom personas

The action supports custom personas via `.github/reviewers/*.{yml,yaml}` in the target repo. Format:

```yaml
name: my-custom-persona
prompt: |
  You are a reviewer focused on <specific concern>.
  <output format instructions>
```

These override built-ins of the same name and add new ones. Built-ins: quality, security, performance, architecture, regression-test, test-value.

## Key inputs (quick reference)

| Input | Purpose | Default |
|---|---|---|
| `team` | Multi-persona spec, e.g. `"quality:1,security:1"` | `""` (single mode) |
| `persona` | Single-persona name (ignored if `team` set) | `"quality"` |
| `litellm-url` | Proxy base URL | required |
| `litellm-api-key` | Proxy API key | required |
| `model` | Model id (deepseek-* family) | `"deepseek-v4-flash"` |
| `skip-coordinator` | Skip synthesis step | `"false"` |

Full input reference: [references/inputs.md](references/inputs.md)

## Outputs

| Output | Meaning |
|---|---|
| `verdict` | `CAN MERGE` / `CONDITIONAL MERGE` / `CANNOT MERGE` / `UNKNOWN` |
| `cacheRead` | Total cache-hit tokens (non-zero = upstream cache hit, discounted billing) |
| `totalCost` | Total USD across all reviewers + coordinator |
