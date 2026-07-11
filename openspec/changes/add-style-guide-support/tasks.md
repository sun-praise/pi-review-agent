## 1. Style-guide loading module

- [x] 1.1 Create `src/style-guide.ts` with a `loadStyleGuide(cwd: string, explicitPath?: string): string | undefined` function.
- [x] 1.2 Implement the detection order: `STYLE_GUIDE.md` → `.github/STYLE_GUIDE.md` → `docs/style-guide.md` → `.github/style-guide.md`.
- [x] 1.3 Add unit tests in `src/style-guide.test.ts` covering detection, explicit override, and missing-file fallback.

## 2. Persona schema and built-ins

- [x] 2.1 Extend `Persona` interface in `src/personas.ts` to include optional `useStyleGuide?: boolean`.
- [x] 2.2 Parse optional `use-style-guide` field from `.github/reviewers/*.yaml` with validation.
- [x] 2.3 Add a new built-in `style` persona focused on style-guide enforcement.
- [x] 2.4 Update `quality` built-in prompt to receive the style-guide when present.
- [x] 2.5 Add tests in `src/personas.test.ts` for custom persona `use-style-guide` parsing and the new built-in persona.

## 3. Prompt injection

- [x] 3.1 Modify `src/orchestrate.ts` to load the style-guide once per review and inject it into personas where `useStyleGuide` is true.
- [x] 3.2 Ensure the `style` persona always receives the guide and the `quality` persona receives it by default when a guide exists.
- [x] 3.3 Update orchestration tests to verify style-guide injection behavior.

## 4. CLI and action inputs

- [x] 4.1 Add `--style-guide` CLI argument to `src/index.ts` and parse it into the options.
- [x] 4.2 Read `PI_REVIEW_STYLE_GUIDE` environment variable as the action-to-CLI bridge.
- [x] 4.3 Add `style-guide` input to `action.yml` and pass it through `PI_REVIEW_STYLE_GUIDE`.

## 5. Documentation and skill

- [x] 5.1 Update `README.md` with style-guide file locations, the `style-guide` action input, and the new `style` persona.
- [x] 5.2 Update `skills/setup-pi-review/SKILL.md` to mention style-guide auto-detection during setup.

## 6. Build and verification

- [x] 6.1 Run `npx tsc --noEmit` and fix type errors.
- [x] 6.2 Run the test suite and fix failures.
- [x] 6.3 Run `npx tsup` to rebuild `dist/index.cjs`.
- [x] 6.4 Commit the source changes and the rebuilt `dist/index.cjs`.
