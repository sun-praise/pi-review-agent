/**
 * Minimal tool set for the review agent: read a file, grep across files.
 *
 * These mirror the shape from pi-mono coding-agent but stripped to what a
 * reviewer needs — read source for context, search for usage patterns.
 * They operate on the process cwd by default; the action wrapper sets cwd
 * to the checked-out repo so paths in reviews match the PR.
 *
 * Security: both tools confine access to `cwd`. The read tool resolves the
 * requested path and rejects anything that escapes the repo tree (absolute
 * paths, `..` traversal, sibling directories — see resolveInside). The grep
 * walker recurses downward from cwd only, so it has no escape vector by
 * construction; the read tool needs an explicit check because it takes a
 * caller-supplied path.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Type, type Static } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

const readFileSchema = Type.Object({
  path: Type.String({ description: "Repository-relative path to read. Must stay inside the repo." }),
  offset: Type.Optional(Type.Number({ description: "1-indexed line to start at. Default 1." })),
  limit: Type.Optional(
    Type.Number({ description: "Max lines to return. Default 2000; hard cap 2000." }),
  ),
});
type ReadFileParams = Static<typeof readFileSchema>;
interface ReadFileDetails {
  lines: number;
  truncated: boolean;
}

/**
 * Resolve `input` against `cwd` and return the absolute path ONLY if it stays
 * inside the repo tree. Returns null when the path escapes (absolute paths,
 * `..` traversal, or a sibling directory whose name shares a prefix with cwd).
 *
 * Uses path.relative — NOT startsWith. startsWith(root) is a classic buggy
 * check: for cwd `/home/user/repo`, the path `/home/user/repo-secret` passes
 * startsWith but is a sibling, not a child. path.relative correctly yields
 * `../repo-secret`, whose leading `..` we reject. On Windows a different-drive
 * absolute path (e.g. `C:\` while cwd is on `D:\`) yields an absolute relative
 * path, which we also reject via the isAbsolute branch.
 *
 * `input === "."` (cwd itself) returns the resolved cwd; reading a directory
 * naturally yields no lines, so it's harmless and avoids false rejections.
 */
function resolveInside(cwd: string, input: string): string | null {
  const root = path.resolve(cwd);
  const resolved = path.resolve(root, input);
  const rel = path.relative(root, resolved);
  if (rel === "") return resolved; // cwd itself
  if (rel === ".." || rel.startsWith(`..${path.sep}`)) return null; // escapes upward
  if (path.isAbsolute(rel)) return null; // different drive (Windows)
  return resolved;
}

export function createReadFileTool(cwd: string): AgentTool<typeof readFileSchema, ReadFileDetails> {
  return {
    label: "read",
    name: "read",
    description:
      "Read a text file from the repo. Returns up to 2000 lines starting at offset. " +
      "Use for examining source the diff touches. Paths must stay inside the repository.",
    parameters: readFileSchema,
    execute: async (_id, params): Promise<AgentToolResult<ReadFileDetails>> => {
      const offset = Math.max(1, params.offset ?? 1);
      const limit = Math.min(2000, params.limit ?? 2000);
      const abs = resolveInside(cwd, params.path);
      if (abs === null) {
        // Return an explicit refusal rather than throwing: a throw looks like
        // a transient/retryable error to the agent loop, which could prompt
        // repeated (and varied) escape attempts. A clear text refusal tells
        // the model this path is off-limits and keeps the loop healthy.
        return {
          content: [{ type: "text", text: "(path outside repository — refused)" }],
          details: { lines: 0, truncated: false },
        };
      }
      const text = await readFile(abs, "utf8");
      const allLines = text.split("\n");
      const slice = allLines.slice(offset - 1, offset - 1 + limit);
      const lines = slice.map((line, i) => `${offset + i}: ${line}`).join("\n");
      return {
        content: [{ type: "text", text: lines }],
        details: { lines: slice.length, truncated: offset - 1 + limit < allLines.length },
      };
    },
  };
}

const grepSchema = Type.Object({
  pattern: Type.String({ description: "Search pattern — regex by default, or literal string when `literal` is true." }),
  glob: Type.Optional(
    Type.String({ description: "Restrict to files matching this glob, e.g. '**/*.ts'." }),
  ),
  literal: Type.Optional(
    Type.Boolean({ description: "Treat pattern as a literal string instead of regex. Default false (regex mode)." }),
  ),
  maxResults: Type.Optional(
    Type.Number({ description: "Cap on matches. Default 50; hard cap 200." }),
  ),
});
type GrepParams = Static<typeof grepSchema>;
interface GrepDetails {
  matches: number;
  truncated: boolean;
}

export interface GrepWalker {
  (cwd: string, pattern: string, glob: string | undefined, cap: number, literal?: boolean): Promise<string>;
}

export function createGrepTool(
  cwd: string,
  walk: GrepWalker,
): AgentTool<typeof grepSchema, GrepDetails> {
  return {
    label: "grep",
    name: "grep",
    description:
      "Search file contents under cwd. Returns matching lines as `file:line:text`. " +
      "Pattern is a regex by default; set `literal: true` for plain substring matching. " +
      "Use to find callers, usages, error-handling patterns, or definitions.",
    parameters: grepSchema,
    execute: async (_id, params): Promise<AgentToolResult<GrepDetails>> => {
      const cap = Math.min(200, params.maxResults ?? 50);
      const out = await walk(cwd, params.pattern, params.glob, cap, params.literal);
      const matches = out ? out.split("\n").length : 0;
      return {
        content: [{ type: "text", text: out || "(no matches)" }],
        details: { matches, truncated: matches >= cap },
      };
    },
  };
}
