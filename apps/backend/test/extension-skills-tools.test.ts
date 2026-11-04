import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { createExtensionSkillAgentTools, createScopedExtensionSkillAgentTools, extensionSkillDirectoryContext } from "../src/extension-skills-tools.js";
import { archiveExtensionSkill, createExtensionSkill, updateExtensionSkill } from "../src/extension-skills-store.js";
import type { ToolSet } from "ai";
import type { ZodType } from "zod";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

afterEach(() => vi.restoreAllMocks());

describe("lazy extension skill context", () => {
  it("loads only enabled name/description context and returns instructions only on demand", async () => {
    const env = { AGENT_AUDIT: customAgentD1().database } as unknown as Env;
    const skillId = await createExtensionSkill(env, "workspace-1", "alice", {
      name: "Concise writer",
      description: "Keeps writing short",
      instructions: "Never exceed three sentences.",
      enabled: true,
      workspaceId: "workspace-1",
      scope: "workspace",
    });
    await createExtensionSkill(env, "workspace-1", "alice", {
      name: "Disabled skill",
      description: "Not offered to the agent",
      instructions: "This body stays hidden.",
      enabled: false,
      workspaceId: "workspace-1",
      scope: "workspace",
    });
    const archivedId = await createExtensionSkill(env, "workspace-1", "alice", {
      name: "Archived skill",
      description: "Do not offer this",
      instructions: "Archived instruction body.",
      enabled: true,
      workspaceId: "workspace-1",
      scope: "workspace",
    });
    expect(await archiveExtensionSkill(env, "workspace-1", "alice", archivedId, 10)).toEqual({ ok: true });

    const context = await extensionSkillDirectoryContext(env, "workspace-1", "bob");
    expect(context).toContain("Concise writer: Keeps writing short");
    expect(context).not.toContain("Never exceed three sentences.");
    expect(context).not.toContain("Disabled skill");
    expect(context).not.toContain("Archived skill");

    type ExecutableTool = { execute(input: Record<string, unknown>): Promise<unknown> };
    const tools = createExtensionSkillAgentTools(env, "workspace-1", "bob") as unknown as {
      list_skills: ExecutableTool;
      get_skill_instructions: ExecutableTool;
    };
    const directory = await tools.list_skills.execute({});
    expect(directory).toEqual([{ _id: skillId, name: "Concise writer", description: "Keeps writing short", enabled: true, version: 1 }]);
    expect(JSON.stringify(directory)).not.toContain("Never exceed three sentences.");
    expect(await tools.get_skill_instructions.execute({ skillId })).toEqual({
      _id: skillId,
      name: "Concise writer",
      instructions: "Never exceed three sentences.",
      version: 1,
    });
  });

  it("rejects stale, disabled, archived, foreign personal and foreign workspace instruction reads", async () => {
    const env = { AGENT_AUDIT: customAgentD1().database } as unknown as Env;
    const create = (userId: string, workspaceId = "workspace-1") => createExtensionSkill(env, "workspace-1", userId, {
      name: "Style", description: "Private writing rules", instructions: "Write short paragraphs.", enabled: true, workspaceId,
    });
    const own = await create("alice");
    const other = await create("bob");
    const foreignWorkspace = await createExtensionSkill(env, "workspace-1", "bob", {
      name: "Other workspace", description: "No access", instructions: "Foreign body", workspaceId: "workspace-2", scope: "workspace",
    });
    const tools = createExtensionSkillAgentTools(env, "workspace-1", "alice");
    const read = (skillId: string, expectedVersion?: number) => execute(tools, "get_skill_instructions", { skillId, expectedVersion });
    expect(await read(other)).toBeNull();
    expect(await read(foreignWorkspace)).toBeNull();
    await updateExtensionSkill(env, "workspace-1", "alice", own, { instructions: "New revision" });
    expect(await read(own, 1)).toBeNull();
    expect(await read(own, 2)).toMatchObject({ instructions: "New revision", version: 2 });
    await updateExtensionSkill(env, "workspace-1", "alice", own, { enabled: false });
    expect(await read(own)).toBeNull();
    await updateExtensionSkill(env, "workspace-1", "alice", own, { enabled: true });
    await archiveExtensionSkill(env, "workspace-1", "alice", own);
    expect(await read(own)).toBeNull();
  });

  it("never accepts model-supplied reader identity or a revoked resolver", async () => {
    const env = { AGENT_AUDIT: customAgentD1().database } as unknown as Env;
    const tools = createScopedExtensionSkillAgentTools(env, async () => null);
    expect((tools.list_skills!.inputSchema as ZodType).safeParse({ userId: "alice", orgId: "workspace-1" }).success).toBe(false);
    expect((tools.get_skill_instructions!.inputSchema as ZodType).safeParse({ skillId: "skill_1", userId: "alice" }).success).toBe(false);
    await expect(execute(tools, "list_skills", {})).rejects.toThrow("active owned employee session");
  });

  it("logs directory failures and tells the agent that the directory is unavailable", async () => {
    const error = new Error("D1 unavailable");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const env = { AGENT_AUDIT: { prepare: () => { throw error; } } } as unknown as Env;
    const context = await extensionSkillDirectoryContext(env, "workspace-1", "alice");
    expect(context).toContain("temporarily unavailable");
    expect(context).toContain("Do not assume that no skills are configured");
    expect(log).toHaveBeenCalledWith("Extension skill directory unavailable.", error);
  });
});

function execute(tools: ToolSet, name: string, input: unknown) {
  return (tools[name]!.execute as (value: unknown, options: unknown) => Promise<unknown>)(input, { toolCallId: "read", messages: [] });
}
