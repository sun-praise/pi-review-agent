/**
 * ESLint config for pi-review-agent.
 *
 * Baseline: typescript-eslint *recommended* (non-type-checked). The repo
 * already runs `tsc --noEmit` (strict) in CI, so the compiler covers
 * type-level correctness; lint focuses on patterns tsc can't catch —
 * unused vars, leaked `debugger`, `var`, duplicate keys, etc.
 *
 * Written as `.mjs` (not `.ts`) so ESLint can load it without the optional
 * `jiti` dependency, which keeps `npm ci` installs minimal in CI.
 *
 * Type-checked rules (recommendedTypeChecked) were considered but produce
 * ~150 false positives in `*.test.ts` against the node:test runner's
 * `it(name, async () => …)` callback idiom (no-floating-promises /
 * require-await). Enabling them cleanly is a follow-up of its own.
 */
import tseslint from "typescript-eslint";

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      // A few deliberate `any`s exist in tool/adapter shims; surface as
      // warning rather than error so CI stays green without churning code.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        // Allow intentionally-unused args/imports prefixed with `_`.
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "sessions/**",
      "examples/**",
    ],
  },
);
