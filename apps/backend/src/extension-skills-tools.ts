import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { orgIdForRecord, type TokenRecord } from "./agent-tokens.js";
import type { Env } from "./env.js";
import {
  getExtensionSkillInstructions,
  listExtensionSkillDirectory,
} from "./extension-skills-store.js";
import type { ToolRegistry } from "./mcp-gateway.js";

const DIRECTORY_CHAR_BUDGET = 1_500;
const scopeSchema = z.enum(["personal", "workspace"]).optional();

function jsonResult(payload: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: { skills: payload },
  };
}

function filterDirectory<T extends { name: string; description: string }>(items: T[], query?: string): T[] {
  const needle = query?.trim().toLocaleLowerCase();
  if (!needle) return items;
  return items.filter((item) => `${item.name} ${item.description}`.toLocaleLowerCase().includes(needle));
}

/**
 * Small system context: archive and disabled rows are excluded, and full
 * instruction bodies are fetched only when the agent calls its read tool.
 */
export async function extensionSkillDirectoryContext(
  env: Env,
  orgId: string,
  userId: string,
): Promise<string> {
  try {
    const directory = (await listExtensionSkillDirectory(env, orgId, userId, { workspaceId: orgId }))
      .filter((skill) => skill.enabled)
      .map(({ name, description }) => ({ name, description }));
    if (directory.length === 0) return "";
    let content = directory.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n");
    if (content.length > DIRECTORY_CHAR_BUDGET) {
      const truncated = content.slice(0, DIRECTORY_CHAR_BUDGET);
      const lastLine = truncated.lastIndexOf("\n");
      content = `${lastLine > 0 ? truncated.slice(0, lastLine) : truncated}\n- [additional skills omitted to fit context budget]`;
    }
    return `\n\nUser-configured skills are available. Check this directory when a skill may apply. Call list_skills to find the skill id, then get_skill_instructions to load its full instructions.\n<skill-directory>\n${content}\n</skill-directory>`;
  } catch (error) {
    // Keep an optional library from blocking the turn, while making the
    // failure visible to operators and preventing the agent from treating it
    // as an empty directory.
    console.error("Extension skill directory unavailable.", error);
    return "\n\nThe user-configured skill directory is temporarily unavailable. Do not assume that no skills are configured.";
  }
}

/** AI SDK tools used by the Shiba agent. */
export function createExtensionSkillAgentTools(
  env: Env,
  orgId: string,
  userId: string,
): ToolSet {
  return {
    list_skills: tool({
      description: "List discoverable user-configured skills. Returns only names and descriptions; use get_skill_instructions to load a relevant skill.",
      inputSchema: z.object({ query: z.string().optional(), scope: scopeSchema }),
      execute: async ({ query, scope }) => {
        const directory = await listExtensionSkillDirectory(env, orgId, userId, {
          workspaceId: orgId,
          ...(scope ? { scope } : {}),
        });
        return filterDirectory(directory.filter((skill) => skill.enabled), query);
      },
    }),
    get_skill_instructions: tool({
      description: "Load the full instructions for one readable skill after deciding it applies to the current task.",
      inputSchema: z.object({ skillId: z.string().min(1).max(160) }),
      execute: async ({ skillId }) => getExtensionSkillInstructions(env, orgId, userId, skillId),
    }),
  };
}

/** MCP variants use the verified principal and org embedded by the Worker. */
export function registerExtensionSkillMcpTools(registry: ToolRegistry, env: Env): void {
  registry.registerTool(
    "list_skills",
    "integrations:read",
    async (args, context) => {
      const query = typeof args.query === "string" ? args.query : undefined;
      const scope = scopeSchema.safeParse(args.scope);
      const directory = await listExtensionSkillDirectory(
        env,
        orgIdForRecord(context.principal),
        context.principal.principal,
        {
          workspaceId: orgIdForRecord(context.principal),
          ...(scope.success && scope.data ? { scope: scope.data } : {}),
        },
      );
      return jsonResult(filterDirectory(directory.filter((skill) => skill.enabled), query));
    },
    {
      description: "List active, readable skills by name and description. Instructions are not included; use get_skill_instructions for one skill.",
      inputSchema: { query: z.string().optional(), scope: scopeSchema },
      annotations: { readOnlyHint: true },
    },
  );

  registry.registerTool(
    "get_skill_instructions",
    "integrations:read",
    async (args, context) => {
      const parsed = z.object({ skillId: z.string().min(1).max(160) }).safeParse(args);
      if (!parsed.success) throw new Error("Invalid skill id.");
      const orgId = orgIdForRecord(context.principal);
      return jsonResult(await getExtensionSkillInstructions(env, orgId, context.principal.principal, parsed.data.skillId));
    },
    {
      description: "Load one readable skill's full instruction body after determining it applies.",
      inputSchema: { skillId: z.string().min(1).max(160) },
      annotations: { readOnlyHint: true },
    },
  );
}
