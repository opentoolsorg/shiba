/**
 * Lazy `run_code` tool — loads @cloudflare/codemode and the MCP registry seam
 * on first execute so Worker cold start does not evaluate codemode.js.
 */
import { tool, type Tool } from "ai";
import { z } from "zod";
import type { TokenRecord } from "./agent-tokens.js";
import type { Env } from "./env.js";

/** Matches @cloudflare/codemode createCodeTool input — single JS source string. */
const runCodeInputSchema = z.object({
  code: z.string().describe("Async arrow function body that calls codemode.<tool>({...})."),
});

const RUN_CODE_DESCRIPTION =
  "Execute JavaScript in an isolated sandbox to use the coworker's tools. " +
  "Write an async arrow function (plain JS, no TypeScript syntax) calling codemode.<tool>({...}); " +
  "chain calls, loop, and filter in code — only the returned value comes back. " +
  "Sends and deletes still queue for human approval; approving is never possible from code.";

type RealRunCode = Tool | null;

async function loadRunCodeTool(
  env: Env,
  ownerMemoryId: string | undefined,
  principal: TokenRecord,
  memoryPrincipal: string | null | undefined,
) {
  const { createRunCodeTool } = await import("./codemode.js");
  return createRunCodeTool(env, ownerMemoryId, principal, memoryPrincipal);
}

function cacheKey(
  env: Env,
  ownerMemoryId: string | undefined,
  principal: TokenRecord,
  memoryPrincipal: string | null | undefined,
): string {
  return [
    env.LOADER ? "1" : "0",
    ownerMemoryId ?? "",
    principal.principal,
    memoryPrincipal ?? "",
  ].join("\0");
}

const realByKey = new Map<string, Promise<RealRunCode>>();

function realToolPromise(
  env: Env,
  ownerMemoryId: string | undefined,
  principal: TokenRecord,
  memoryPrincipal: string | null | undefined,
): Promise<RealRunCode> {
  const key = cacheKey(env, ownerMemoryId, principal, memoryPrincipal);
  let pending = realByKey.get(key);
  if (!pending) {
    pending = loadRunCodeTool(env, ownerMemoryId, principal, memoryPrincipal);
    realByKey.set(key, pending);
  }
  return pending;
}

/** Test seam — reset cached codemode loads between cases. */
export function resetLazyRunCodeCacheForTests(): void {
  realByKey.clear();
}

export function createLazyRunCodeTool(
  env: Env,
  ownerMemoryId: string | undefined,
  principal: TokenRecord,
  memoryPrincipal: string | null | undefined,
): Tool | null {
  if (!env.LOADER) return null;
  return tool({
    description: RUN_CODE_DESCRIPTION,
    inputSchema: runCodeInputSchema,
    execute: async (input, options) => {
      const real = await realToolPromise(env, ownerMemoryId, principal, memoryPrincipal);
      if (!real?.execute) throw new Error("Code mode is not available.");
      return real.execute(input, options);
    },
  });
}

/** Preload codemode on the DO hot path (after cold start) so descriptions include generated types. */
export async function warmRunCodeTool(
  env: Env,
  ownerMemoryId: string | undefined,
  principal: TokenRecord,
  memoryPrincipal: string | null | undefined,
): Promise<Tool | null> {
  if (!env.LOADER) return null;
  const real = await realToolPromise(env, ownerMemoryId, principal, memoryPrincipal);
  return real;
}