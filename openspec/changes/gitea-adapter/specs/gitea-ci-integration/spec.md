## ADDED Requirements

### Requirement: Gitea Actions workflow support
The system SHALL support running as a step in Gitea Actions workflows.

#### Scenario: Gitea Actions environment detection
- **WHEN** `GITHUB_ACTIONS` environment variable is `true`
- **AND** `GITEA_URL` environment variable is set
- **THEN** the system recognizes it's running in Gitea Actions

#### Scenario: Gitea Actions token usage
- **WHEN** running in Gitea Actions
- **AND** `GITHUB_TOKEN` is available
- **THEN** the system uses it for API authentication (Gitea Actions provides this)

#### Scenario: Gitea Actions output
- **WHEN** running in Gitea Actions
- **THEN** the system writes outputs to `$GITHUB_OUTPUT` (Gitea Actions compatibility)
- **AND** writes step summary to `$GITHUB_STEP_SUMMARY`

### Requirement: Standalone CLI mode
The system SHALL support running as a standalone CLI tool without CI/CD integration.

#### Scenario: CLI with explicit parameters
- **WHEN** `pi-review-agent --platform gitea --gitea-url https://gitea.example.com --gitea-token xxx --pr 123` is executed
- **THEN** it runs the review without requiring CI/CD environment

#### Scenario: CLI with environment variables
- **WHEN** `GITEA_URL`, `GITEA_TOKEN`, and `GITEA_PR_NUMBER` are set
- **AND** `pi-review-agent` is executed without CI/CD-specific flags
- **THEN** it runs in standalone mode

#### Scenario: CLI output
- **WHEN** running in standalone CLI mode
- **THEN** the system outputs review results to stdout
- **AND** exits with code 0 on success, 1 on failure (based on severity gate)

### Requirement: Gitea-specific environment variables
The system SHALL support Gitea-specific environment variables for configuration.

#### Scenario: Required Gitea variables
- **WHEN** configuring for Gitea
- **THEN** the system recognizes: `GITEA_URL`, `GITEA_TOKEN`, `GITEA_REPOSITORY`, `GITEA_PR_NUMBER`

#### Scenario: Optional Gitea variables
- **WHEN** configuring for Gitea
- **THEN** the system recognizes optional: `GITEA_API_VERSION` (default: `v1`)

#### Scenario: Variable precedence
- **WHEN** both CLI arguments and environment variables are provided
- **THEN** CLI arguments take precedence over environment variables

### Requirement: GitHub Actions composite action adaptation
The system SHALL provide guidance for adapting the existing GitHub Actions composite action for Gitea.

#### Scenario: Gitea Actions workflow example
- **WHEN** a user wants to run pi-review-agent in Gitea Actions
- **THEN** documentation provides a workflow YAML example
- **AND** the example uses `uses: sun-praise/pi-review-agent@v1` with Gitea-specific env vars

#### Scenario: Manual setup instructions
- **WHEN** a user wants to run standalone CLI in Gitea CI
- **THEN** documentation provides step-by-step setup instructions
- **AND** includes example of downloading and running the CLI binary

### Requirement: Session cache compatibility
The system SHALL support session caching in Gitea environment.

#### Scenario: Gitea Actions cache
- **WHEN** running in Gitea Actions
- **THEN** the system uses `actions/cache@v5` compatible caching (Gitea Actions supports this)

#### Scenario: Standalone cache
- **WHEN** running in standalone CLI mode
- **AND** `--sessions-root` is provided
- **THEN** the system stores session files in the specified directory
- **AND** reuses sessions across runs for the same PR

### Requirement: Error messages for Gitea context
The system SHALL provide clear error messages specific to Gitea configuration issues.

#### Scenario: Missing Gitea URL
- **WHEN** `GITEA_TOKEN` is set but `GITEA_URL` is missing
- **THEN** the system shows error: "GITEA_URL is required when using Gitea platform"

#### Scenario: Invalid Gitea URL
- **WHEN** `GITEA_URL` is not a valid URL
- **THEN** the system shows error: "Invalid GITEA_URL format"

#### Scenario: PR number missing
- **WHEN** running in Gitea mode
- **AND** no PR number is provided via env or CLI
- **THEN** the system shows error: "PR number is required. Set GITEA_PR_NUMBER or use --pr flag"
