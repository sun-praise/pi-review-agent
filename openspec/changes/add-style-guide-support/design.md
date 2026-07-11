## Context

`pi-review-agent` already loads custom personas from `.github/reviewers/*.yaml`. Each persona carries a single `prompt` string that is passed to the review agent as its system prompt. There is no mechanism to share a common style document across personas, so teams either duplicate style rules into every persona or skip style guidance entirely.

The codebase uses `src/personas.ts` to load and merge built-in and custom personas, and `src/orchestrate.ts` to run each persona as an independent review session with its own system prompt.

## Goals / Non-Goals

**Goals:**
- Automatically discover and load a repo-level style-guide file.
- Inject the style-guide into the prompts of relevant personas.
- Add a dedicated `style` built-in persona focused on style-guide enforcement.
- Allow explicit style-guide path override via CLI and action input.
- Let custom personas opt in or out of style-guide injection.
- Keep behavior backward-compatible: reviews work unchanged when no style-guide exists.

**Non-Goals:**
- Parsing structured style rules (e.g., JSON/YAML style configs).
- Running linters or formatters automatically.
- Modifying the PR or repository.
- Supporting style-guide files larger than a reasonable prompt budget.

## Decisions

1. **Detection order**: `STYLE_GUIDE.md` → `.github/STYLE_GUIDE.md` → `docs/style-guide.md` → `.github/style-guide.md`.
   - Rationale: Covers the most common conventions without over-engineering. Case-insensitive matching on the basename keeps it forgiving.

2. **Injection point**: Append the style-guide after the persona prompt inside `src/personas.ts` (or where prompts are resolved in `src/orchestrate.ts`).
   - Rationale: The style-guide is context for the reviewer, not a replacement for its focus. Appending keeps the persona's primary identity intact.

3. **Opt-in field for custom personas**: Add optional `use-style-guide: boolean` to the persona YAML schema.
   - Rationale: Some custom personas (e.g., security) may not benefit from style guidance. Default `false` avoids surprising existing custom personas.

4. **Built-ins that receive the guide by default**: `style` (always) and `quality` (when a guide is present).
   - Rationale: `quality` already mentions “Code style consistency”, so it naturally benefits. `style` is purpose-built for this feature.

5. **Action input naming**: `style-guide`.
   - Rationale: Matches common GitHub Actions kebab-case input conventions.

6. **No truncation in core logic**: If a style-guide is too large, the prompt will be large. We rely on the existing diff size limits and the LLM proxy to reject oversized payloads, mirroring current behavior.
   - Rationale: Adds no new complexity; teams can split or summarize over-sized guides.

## Risks / Trade-offs

- **[Risk] Prompt bloat** → Large style-guides increase token usage and cost. **Mitigation**: Document the recommendation to keep guides concise; users can opt out per persona.
- **[Risk] Conflicting guidance** → A persona prompt and the style-guide may contradict each other. **Mitigation**: Document that the style-guide is supplemental; persona focus takes precedence in case of conflict.
- **[Risk] Existing custom persona breakage** → Adding `use-style-guide` as optional preserves backward compatibility.
- **[Risk] Case-sensitivity on case-sensitive file systems** → Use explicit ordered list of supported paths rather than scanning directories.

## Migration Plan

No migration needed. The feature is additive and only activates when a supported style-guide file exists or an explicit path is provided.

## Open Questions

- Should the `style` persona be included in the default team spec, or left for users to add explicitly?
- Should `use-style-guide` default to `true` for new custom personas to encourage adoption?
