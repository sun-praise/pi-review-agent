## ADDED Requirements

### Requirement: Auto-detect repository style-guide
The system SHALL locate a repository-level style-guide file when one exists in a supported location.

#### Scenario: Default style-guide in repository root
- **WHEN** the repository contains `STYLE_GUIDE.md` in its root
- **THEN** the agent SHALL load that file as the style-guide for the current review

#### Scenario: GitHub-style style-guide location
- **WHEN** the repository contains `.github/STYLE_GUIDE.md`
- **THEN** the agent SHALL load that file as the style-guide for the current review

#### Scenario: Docs style-guide location
- **WHEN** the repository contains `docs/style-guide.md`
- **THEN** the agent SHALL load that file as the style-guide for the current review

### Requirement: Manual style-guide path override
The system SHALL allow users to specify an explicit style-guide file path via CLI argument or action input.

#### Scenario: CLI override
- **WHEN** the user passes `--style-guide ./path/to/guide.md`
- **THEN** the agent SHALL use that file instead of auto-detection

#### Scenario: Action input override
- **WHEN** the GitHub Action input `style-guide` is set
- **THEN** the agent SHALL use that file instead of auto-detection

### Requirement: Inject style-guide into reviewer prompts
The system SHALL append the loaded style-guide content to the system prompt of every reviewer that is configured to receive it.

#### Scenario: Built-in style persona receives the guide
- **WHEN** the `style` persona is part of the review team
- **THEN** its system prompt SHALL include the loaded style-guide content

#### Scenario: Quality persona receives the guide by default
- **WHEN** the `quality` persona is part of the review team and a style-guide is present
- **THEN** its system prompt SHALL include the loaded style-guide content

### Requirement: Custom personas opt into style-guide
The system SHALL allow custom personas defined in `.github/reviewers/*.yaml` to declare whether they receive the style-guide.

#### Scenario: Opt-in custom persona
- **WHEN** a custom persona file contains `use-style-guide: true`
- **THEN** the agent SHALL inject the style-guide into that persona's prompt

#### Scenario: Opt-out custom persona
- **WHEN** a custom persona file does not contain `use-style-guide: true`
- **THEN** the agent SHALL NOT inject the style-guide into that persona's prompt

### Requirement: Graceful fallback when no style-guide exists
The system SHALL continue review normally when no style-guide file is found or specified.

#### Scenario: No style-guide available
- **WHEN** no supported style-guide file exists and no path is explicitly provided
- **THEN** the agent SHALL skip style-guide injection and run the review without error
