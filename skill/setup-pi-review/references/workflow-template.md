# Workflow template

Drop this into `.github/workflows/pi-review.yml` in the target repo.

## Team mode (recommended)

Runs 3 personas (quality, security, performance) in parallel + a coordinator that synthesizes a single verdict, and posts one PR comment (edited in place on re-push).

```yaml
name: pi-review

on:
  pull_request:
    branches: [main]

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write   # required to post the review comment
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: pi-review-agent
        uses: sun-praise/pi-review-agent@v1
        with:
          team: "quality:1,security:1,performance:1"
          litellm-url: ${{ secrets.LITELLM_URL }}
          litellm-api-key: ${{ secrets.LITELLM_API_KEY }}
```

## Full 6-persona team

```yaml
team: "quality:1,security:1,performance:1,architecture:1,regression-test:1,test-value:1"
```

Cost scales linearly with persona count. 3 personas is a good default; expand when you want deeper coverage.

## Single-persona mode

Runs one reviewer, no coordinator, no PR comment (output goes to step summary only). Useful for quick checks or cost-constrained setups.

```yaml
name: pi-review

on:
  pull_request:
    branches: [main]

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4

      - name: pi-review-agent
        uses: sun-praise/pi-review-agent@v1
        with:
          persona: quality
          litellm-url: ${{ secrets.LITELLM_URL }}
          litellm-api-key: ${{ secrets.LITELLM_API_KEY }}
```

## Custom model

If the LiteLLM proxy routes a different model name (still DeepSeek-family for correct cache/cost accounting):

```yaml
with:
  team: "quality:1,security:1"
  model: "deepseek-v4-pro"
  litellm-url: ${{ secrets.LITELLM_URL }}
  litellm-api-key: ${{ secrets.LITELLM_API_KEY }}
```

## Trigger only on specific paths

To avoid running review on doc-only or generated changes:

```yaml
on:
  pull_request:
    branches: [main]
    paths:
      - 'src/**'
      - 'tests/**'
      - '!**/*.md'
      - '!docs/**'
```

## Fail CI on verdict

The action exposes `verdict` as a step output. To fail CI when the verdict is CANNOT MERGE:

```yaml
      - name: pi-review-agent
        id: review
        uses: sun-praise/pi-review-agent@v1
        with:
          team: "quality:1,security:1"
          litellm-url: ${{ secrets.LITELLM_URL }}
          litellm-api-key: ${{ secrets.LITELLM_API_KEY }}

      - name: gate on verdict
        if: steps.review.outputs.verdict == 'CANNOT MERGE'
        run: |
          echo "review blocked merge (verdict: ${{ steps.review.outputs.verdict }})"
          exit 1
```
