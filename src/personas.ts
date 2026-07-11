/**
 * Persona definitions for the review agent.
 *
 * Each persona is a focused reviewer with its own system prompt, run as its
 * own session (its own JSONL, its own cache prefix). The 6 built-in personas
 * mirror opencode-actions/multi-review's defaults so teams can drop-in switch.
 *
 * Custom personas: drop `.yaml`/`.yml` files in `<cwd>/.github/reviewers/`
 * with `name` + `prompt` fields. They override built-ins of the same name and
 * add new ones.
 */
import { load as yamlLoad } from "js-yaml";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export interface Persona {
  name: string;
  prompt: string;
  /** When true, the repository style-guide (if found) is appended to this persona's system prompt. */
  useStyleGuide?: boolean;
}

interface PersonaFileShape {
  name: unknown;
  prompt: unknown;
  "use-style-guide"?: unknown;
}

const DECISION_RULES = [
  "Decision rules:",
  "- Use 'CAN MERGE' only when there are no blocking issues.",
  "- Use 'CONDITIONAL MERGE' when merge is acceptable only after specific issues are fixed.",
  "- Use 'CANNOT MERGE' when there are blocking risks, correctness issues, or major concerns.",
].join("\n");

const OUTPUT_FORMAT = [
  "Output format:",
  "- First line: the decision only (CAN MERGE / CONDITIONAL MERGE / CANNOT MERGE)",
  "- Then a short summary",
  "- Then 'Blocking Issues' listing required fixes; if none, write 'Blocking Issues: None'",
  "- Then 'Warnings' listing non-blocking issues; if none, write 'Warnings: None'",
  "- Then 'Suggestions' listing improvements; if none, write 'Suggestions: None'",
  "",
  "Do not use '#N' format to number items (GitHub turns these into issue/PR links). Use '1.' or '-' lists.",
].join("\n");

function reviewerHead(focus: string, checks: string[]): string {
  return [
    `You are a senior code reviewer focused on ${focus}.`,
    "Read-only review: do not modify code, do not run bash or shell commands. You may use the `read` and `grep` tools to inspect surrounding source.",
    "",
    "Check:",
    ...checks.map((c) => `- ${c}`),
    "",
    DECISION_RULES,
    OUTPUT_FORMAT,
  ].join("\n");
}

export const BUILT_IN_PERSONAS: Persona[] = [
  {
    name: "quality",
    useStyleGuide: true,
    prompt: reviewerHead("code quality", [
      "Code quality issues",
      "Potential bugs or logic errors",
      "Code style consistency",
      "Error handling completeness",
    ]),
  },
  {
    name: "style",
    useStyleGuide: true,
    prompt: reviewerHead("style-guide enforcement", [
      "Conformance to the repository style-guide provided below",
      "Naming conventions, formatting, and project-specific patterns",
      "Consistency with documented style rules",
      "Readability and maintainability issues that the style-guide calls out",
    ]),
  },
  {
    name: "security",
    prompt: reviewerHead("security", [
      "Input validation and sanitization",
      "Auth/authz correctness",
      "Secrets and sensitive data exposure",
      "Injection and unsafe operations",
    ]),
  },
  {
    name: "performance",
    prompt: reviewerHead("performance", [
      "Algorithm complexity and hot paths",
      "Unnecessary allocations or copies",
      "N+1 queries and redundant work",
      "Resource leaks (file handles, connections)",
    ]),
  },
  {
    name: "architecture",
    prompt: reviewerHead("architecture", [
      "Coupling: unnecessary dependencies between modules",
      "Abstraction level: leaky or premature",
      "Cohesion: unrelated concerns mixed",
      "Boundaries: layering violations",
    ]),
  },
  {
    name: "regression-test",
    prompt: reviewerHead("regression test coverage", [
      "Bug fixes: does the PR add a test that reproduces the bug?",
      "Behavior changes: are observable changes tested?",
      "New features: are happy-path and edge cases covered?",
      "Refactors: are existing tests still meaningful?",
    ]),
  },
  {
    name: "test-value",
    prompt: reviewerHead("low-value tests", [
      "Empty/soft assertions (no real assert, always-true checks)",
      "Tests that duplicate the implementation instead of describing behavior",
      "Tests that pass regardless of correctness",
      "Tests covering trivial getters/setters with no logic",
    ]),
  },
];

const BUILT_IN_BY_NAME: Record<string, Persona> = Object.fromEntries(
  BUILT_IN_PERSONAS.map((p) => [p.name, p]),
);

function isPersonaFile(
  v: unknown,
): v is PersonaFileShape & { name: string; prompt: string; "use-style-guide"?: boolean } {
  if (typeof v !== "object" || v === null) return false;
  if (!("name" in v) || !("prompt" in v)) return false;
  const obj = v as PersonaFileShape;
  if (typeof obj.name !== "string" || typeof obj.prompt !== "string") return false;
  if (obj["use-style-guide"] !== undefined && typeof obj["use-style-guide"] !== "boolean") {
    return false;
  }
  return true;
}

/**
 * Load personas: built-ins overlaid with any `.yaml`/`.yml` files found in
 * `<cwd>/.github/reviewers/`. Files override built-ins of the same name and
 * add new personas. Returns the merged list, built-ins first then customs.
 */
export function loadPersonas(cwd: string): Persona[] {
  const dir = path.join(cwd, ".github", "reviewers");
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [...BUILT_IN_PERSONAS];
  }

  const byName: Record<string, Persona> = { ...BUILT_IN_BY_NAME };
  const order: string[] = BUILT_IN_PERSONAS.map((p) => p.name);
  for (const entry of entries) {
    if (!/\.(ya?ml)$/.test(entry)) continue;
    const full = path.join(dir, entry);
    const raw = readFileSync(full, "utf8");
    const parsed = yamlLoad(raw);
    if (!isPersonaFile(parsed)) {
      throw new Error(
        `${full}: persona file must have string 'name' and string 'prompt' fields, ` +
          "and optional 'use-style-guide' boolean",
      );
    }
    const persona: Persona = {
      name: parsed.name,
      prompt: parsed.prompt,
      useStyleGuide: parsed["use-style-guide"],
    };
    if (!byName[persona.name]) order.push(persona.name);
    byName[persona.name] = persona;
  }
  return order.map((name) => byName[name]);
}

/**
 * Resolve a team spec like "quality:1,security:2" into a persona list with
 * repetitions (count = how many parallel instances). Count >1 is accepted but
 * currently runs as count=1 (multi-instance is a later optimization; the spec
 * stays compatible with opencode-actions).
 */
export interface ResolvedTeam {
  personas: Persona[];
  unknown: string[];
}

export function resolveTeam(spec: string | undefined, available: Persona[]): ResolvedTeam {
  if (!spec) {
    return { personas: [...available], unknown: [] };
  }
  const byName: Record<string, Persona> = Object.fromEntries(
    available.map((p) => [p.name, p]),
  );
  const personas: Persona[] = [];
  const unknown: string[] = [];
  for (const part of spec.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [name, countStr] = trimmed.split(":");
    const count = countStr ? Math.max(1, Number(countStr) || 1) : 1;
    const persona = byName[name ?? ""];
    if (!persona) {
      unknown.push(name ?? "");
      continue;
    }
    for (let i = 0; i < count; i++) personas.push(persona);
  }
  return { personas, unknown };
}
