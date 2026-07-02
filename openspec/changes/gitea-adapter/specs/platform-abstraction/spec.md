## ADDED Requirements

### Requirement: Platform adapter interface
The system SHALL define a `PlatformAdapter` interface that abstracts all platform-specific operations.

#### Scenario: Interface definition
- **WHEN** the platform module is imported
- **THEN** it exports a `PlatformAdapter` interface with methods: `fetchPrContext`, `postComment`, `resolvePrFromEnv`

#### Scenario: Method signatures
- **WHEN** a developer inspects the `PlatformAdapter` interface
- **THEN** `fetchPrContext` accepts `PrContextOptions` and returns `Promise<PrContext>`
- **AND** `postComment` accepts `PrCommentContext` and `string` and returns `Promise<void>`
- **AND** `resolvePrFromEnv` returns `PrInfo | null`

### Requirement: Platform adapter factory
The system SHALL provide a factory function to create platform adapters based on configuration.

#### Scenario: Create GitHub adapter
- **WHEN** `createAdapter('github')` is called
- **THEN** it returns a GitHub adapter instance implementing `PlatformAdapter`

#### Scenario: Create Gitea adapter
- **WHEN** `createAdapter('gitea')` is called
- **THEN** it returns a Gitea adapter instance implementing `PlatformAdapter`

#### Scenario: Invalid platform
- **WHEN** `createAdapter('unsupported')` is called
- **THEN** it throws an error indicating unsupported platform

### Requirement: Platform auto-detection
The system SHALL automatically detect the platform from environment variables when not explicitly specified.

#### Scenario: Gitea environment detected
- **WHEN** `GITEA_URL` or `GITEA_TOKEN` environment variable exists
- **AND** no `--platform` CLI argument is provided
- **THEN** the system uses the Gitea adapter

#### Scenario: GitHub environment detected
- **WHEN** `GITHUB_REPOSITORY` environment variable exists
- **AND** no `GITEA_*` variables exist
- **AND** no `--platform` CLI argument is provided
- **THEN** the system uses the GitHub adapter

#### Scenario: CLI argument overrides detection
- **WHEN** `--platform gitea` CLI argument is provided
- **AND** `GITHUB_REPOSITORY` environment variable exists
- **THEN** the system uses the Gitea adapter (CLI takes precedence)

#### Scenario: No platform detected
- **WHEN** no `GITEA_*` or `GITHUB_*` environment variables exist
- **AND** no `--platform` CLI argument is provided
- **THEN** the system exits with an error message indicating platform detection failed

### Requirement: Unified PR context structure
The system SHALL define a unified `PrContext` structure that abstracts platform-specific PR data.

#### Scenario: GitHub PR context mapping
- **WHEN** GitHub PR data is fetched
- **THEN** it maps to `PrContext` with fields: `title`, `body`, `comments`, `reviews`, `changedFiles`, `headSha`

#### Scenario: Gitea PR context mapping
- **WHEN** Gitea PR data is fetched
- **THEN** it maps to `PrContext` with the same fields as GitHub
- **AND** Gitea-specific fields (e.g., `merge_base`) are mapped to appropriate unified fields

### Requirement: Unified comment context structure
The system SHALL define a unified `PrCommentContext` structure for posting comments.

#### Scenario: Comment context fields
- **WHEN** a comment needs to be posted
- **THEN** `PrCommentContext` contains: `apiBase`, `repository`, `pr`, `token`, `headSha`
- **AND** platform-specific fields are abstracted away
