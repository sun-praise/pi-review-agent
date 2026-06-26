import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  // CJS so the bundle can `require()` CommonJS deps (the `yaml` package
  // pulled in by pi-agent-core is CJS). ESM-only bundles break on dynamic
  // require. The action invokes `node dist/index.cjs`.
  format: ["cjs"],
  platform: "node",
  target: "node22",
  outExtension: () => ({ js: ".cjs" }),
  splitting: false,
  sourcemap: false,
  clean: true,
  // Inline everything so the action ships a single dist/index.cjs and needs
  // no `npm install` on the runner — same model as opencode-actions.
  noExternal: [/.*/],
});
