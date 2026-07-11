## Why

Currently `pi-review-agent` only supports custom review personas via `.github/reviewers/*.yaml`, where style rules must be duplicated into each persona's prompt. Teams that maintain a dedicated `STYLE_GUIDE.md` or `.github/STYLE_GUIDE.md` have no way to inject that document into the review context. Loading the repo's own style-guide automatically would make style reviews consistent, maintainable, and reusable across personas.

## What Changes

- Detect and read a repository-level style-guide file at review time.
- Support common paths and names: `STYLE_GUIDE.md`, `.github/STYLE_GUIDE.md`, `docs/style-guide.md`, and `.github/style-guide.md`.
- Inject the style-guide content into the system prompt of every persona that focuses on style or code quality.
- Add a dedicated built-in `style` persona that is solely focused on enforcing the style-guide.
- Allow custom personas to opt into receiving the style-guide via a new boolean field in `.github/reviewers/*.yaml`.
- Expose an optional `style-guide` input in `action.yml` so users can override the auto-detected path.
- Update `README.md` and the installer skill documentation to describe the new capability.

## Capabilities

### New Capabilities

- `style-guide`: Automatically locate, load, and inject a repository style-guide into reviewer prompts.

### Modified Capabilities

- (no existing specs to modify)

## Impact

- `src/personas.ts` and `src/orchestrate.ts`: style-guide loading and prompt injection.
- `src/index.ts` and `action.yml`: new CLI flag / action input for explicit style-guide path.
- `README.md` and `skills/setup-pi-review/SKILL.md`: user-facing documentation.
- New built-in persona `style` in `src/personas.ts`.
