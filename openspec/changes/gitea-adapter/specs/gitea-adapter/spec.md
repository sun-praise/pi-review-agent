## ADDED Requirements

### Requirement: Gitea PR context fetching
The system SHALL fetch pull request context from Gitea REST API v1.

#### Scenario: Fetch PR metadata
- **WHEN** `fetchPrContext` is called with Gitea adapter
- **THEN** it calls `GET /api/v1/repos/{owner}/{repo}/pulls/{index}`
- **AND** returns PR title, body, state, and head SHA

#### Scenario: Fetch PR comments
- **WHEN** `fetchPrContext` is called with Gitea adapter
- **THEN** it calls `GET /api/v1/repos/{owner}/{repo}/issues/{index}/comments`
- **AND** filters out bot-authored comments
- **AND** returns comments with author, body, and creation time

#### Scenario: Fetch PR reviews
- **WHEN** `fetchPrContext` is called with Gitea adapter
- **THEN** it calls `GET /api/v1/repos/{owner}/{repo}/pulls/{index}/reviews`
- **AND** returns reviews with state (APPROVED, CHANGES_REQUESTED, COMMENTED)

#### Scenario: Fetch changed files
- **WHEN** `fetchPrContext` is called with Gitea adapter
- **THEN** it calls `GET /api/v1/repos/{owner}/{repo}/pulls/{index}/files`
- **AND** returns file list with status (added, modified, deleted) and patch

#### Scenario: API error handling
- **WHEN** Gitea API returns 404
- **THEN** the system throws an error indicating PR not found
- **WHEN** Gitea API returns 401/403
- **THEN** the system throws an error indicating authentication failure

### Requirement: Gitea comment posting
The system SHALL post and update review comments on Gitea pull requests.

#### Scenario: Post new comment
- **WHEN** `postComment` is called with a new comment
- **THEN** it calls `POST /api/v1/repos/{owner}/{repo}/issues/{index}/comments`
- **AND** includes the review body in the request

#### Scenario: Update existing comment
- **WHEN** `postComment` is called to update an existing comment
- **AND** a comment with the pi-review-agent marker exists
- **THEN** it calls `PATCH /api/v1/repos/{owner}/{repo}/issues/comments/{id}`
- **AND** updates the comment body in place

#### Scenario: Comment idempotency
- **WHEN** `postComment` is called multiple times for the same PR
- **THEN** it uses a hidden HTML marker (`<!-- pi-review-agent -->`) to identify existing comments
- **AND** updates the existing comment instead of creating duplicates

### Requirement: Gitea authentication
The system SHALL authenticate with Gitea using Bearer token.

#### Scenario: Token from environment
- **WHEN** `GITEA_TOKEN` environment variable is set
- **THEN** the adapter uses it as Bearer token in API requests

#### Scenario: Token from CLI
- **WHEN** `--gitea-token` CLI argument is provided
- **THEN** it overrides `GITEA_TOKEN` environment variable

#### Scenario: Missing token
- **WHEN** no token is provided
- **THEN** the system throws an error indicating authentication token is required

### Requirement: Gitea API base URL configuration
The system SHALL configure the Gitea API base URL.

#### Scenario: URL from environment
- **WHEN** `GITEA_URL` environment variable is set
- **THEN** the adapter uses it as the API base URL (e.g., `https://gitea.example.com`)

#### Scenario: URL from CLI
- **WHEN** `--gitea-url` CLI argument is provided
- **THEN** it overrides `GITEA_URL` environment variable

#### Scenario: Default URL
- **WHEN** no URL is provided
- **THEN** the system defaults to `http://localhost:3000`

### Requirement: Gitea PR number resolution
The System SHALL resolve the PR number from Gitea environment variables.

#### Scenario: PR from environment
- **WHEN** `GITEA_PR_NUMBER` environment variable is set
- **THEN** `resolvePrFromEnv` returns it as the PR number

#### Scenario: PR from Gitea Actions context
- **WHEN** running in Gitea Actions
- **AND** `GITHUB_REF` is in format `refs/pull/{N}/merge` (Gitea Actions compatibility)
- **THEN** `resolvePrFromEnv` extracts and returns `{N}`

#### Scenario: PR from CLI
- **WHEN** `--pr` CLI argument is provided
- **THEN** it overrides environment-based PR resolution
