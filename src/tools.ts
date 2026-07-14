/**
 * Minimal tool set for the review agent: read a file, grep across files.
 *
 * These mirror the shape from pi-mono coding-agent but stripped to what a
 * reviewer needs — read source for context, search for usage patterns.
 * They operate on the process cwd by default; the action wrapper sets cwd
 * to the checked-out repo so paths in reviews match the PR.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Type, type Static } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

const readFileSchema = Type.Object({
  path: Type.String({ description: "Repository-relative or absolute path to read." }),
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

export function createReadFileTool(cwd: string): AgentTool<typeof readFileSchema, ReadFileDetails> {
  return {
    label: "read",
    name: "read",
    description:
      "Read a text file from the repo. Returns up to 2000 lines starting at offset. " +
      "Use for examining source the diff touches.",
    parameters: readFileSchema,
    execute: async (_id, params): Promise<AgentToolResult<ReadFileDetails>> => {
      const offset = Math.max(1, params.offset ?? 1);
      const limit = Math.min(2000, params.limit ?? 2000);
      const abs = path.isAbsolute(params.path) ? params.path : path.resolve(cwd, params.path);
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
