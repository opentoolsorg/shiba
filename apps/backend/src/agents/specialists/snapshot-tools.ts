import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { ExploreInput } from "./contract.js";

/** Snapshot tools have no filesystem, network, environment, or write capability. */
export function createSnapshotTools(input: ExploreInput): ToolSet {
  const search = (query: string, symbolsOnly = false) => {
    const found: { path: string; line: number; text: string }[] = [];
    for (const file of input.files) {
      for (const [index, line] of file.content.split("\n").entries()) {
        if (!line.toLowerCase().includes(query.toLowerCase())) continue;
        if (symbolsOnly && !/\b(class|function|interface|type|const|let|def|export)\b/.test(line)) continue;
        found.push({ path: file.path, line: index + 1, text: line.slice(0, 400) });
        if (found.length === 64) return found;
      }
    }
    return found;
  };
  return {
    file_read: tool({
      description: "Read a file from the explicit repository snapshot. Paths outside this snapshot are unavailable.",
      inputSchema: z.strictObject({ path: z.string().min(1).max(512) }),
      execute: async ({ path }) => {
        const file = input.files.find((item) => item.path === path);
        return file ? { path: file.path, content: file.content } : { error: "File is outside the supplied snapshot." };
      },
    }),
    symbol_search: tool({
      description: "Find symbol declarations within the supplied snapshot using a literal query.",
      inputSchema: z.strictObject({ query: z.string().min(1).max(200) }),
      execute: async ({ query }) => ({ matches: search(query, true) }),
    }),
    repo_query: tool({
      description: "Search the explicit repository snapshot for literal text, or list paths with an empty query.",
      inputSchema: z.strictObject({ query: z.string().max(200) }),
      execute: async ({ query }) => query ? { matches: search(query) } : { paths: input.files.map((file) => file.path) },
    }),
  };
}
