import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolSet } from "ai";
import type { Env } from "../src/env.js";

const sessions = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock("agents/routing", () => ({ getAgentByName: async () => ({ fetch: async () => Response.json({ sessions: sessions.rows }) }) }));
vi.mock("@cloudflare/think", () => ({ Think: class { getTools() { return {}; } } }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
vi.mock("../src/agents/specialists/tools.js", () => ({ createSpecialistTools: () => ({}) }));

import { CodingOrchestrator } from "../src/agents/orchestrator.js";
import { createCustomAgent, updateCustomAgent } from "../src/custom-agents-store.js";
import { createExtensionSkill, updateExtensionSkill } from "../src/extension-skills-store.js";
import { createWebSession } from "../src/web-sessions.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const owner = "owner@example.test";
function host(env: Env, name: string, metadata: Record<string, unknown>) {
  return Object.assign(Object.create(CodingOrchestrator.prototype) as object, {
    env, name, state: { runs: [] }, messages: [{ role: "user", id: "turn", metadata }],
    approvedRunDelegate: () => ({}), employeeDraftStore: () => ({}),
    employeeOnboardingBinding: async () => undefined,
    setState(state: unknown) { Object.assign(this, { state }); },
  }) as unknown as CodingOrchestrator;
}
function execute(tools: ToolSet, name: string, input: unknown) {
  return (tools[name]!.execute as (value: unknown, options: unknown) => Promise<unknown>)(input, { toolCallId: "skill-read", messages: [] });
}
beforeEach(() => { sessions.rows = []; });

describe("employee extension skill runtime", () => {
  it("uses real owned app-session scope without grants, and rechecks session and enablement on every call", async () => {
    const env = { AGENT_AUDIT: customAgentD1().database, CodingOrchestrator: {} } as unknown as Env;
    Object.defineProperty(env, "Sandbox", { get: () => { throw new Error("Skills must never create a sandbox"); } });
    const employee = await createCustomAgent(env, "self-hosted", owner, { name: "Writer", instructions: "Write drafts", harness: "opencode", toolScopes: [] });
    const session = createWebSession(owner, { metadata: { customAgentId: employee.id } });
    sessions.rows = [session];
    const skillId = await createExtensionSkill(env, "self-hosted", owner, { name: "Style", description: "Short drafts", instructions: "Write short paragraphs.", enabled: true, workspaceId: "self-hosted" });
    await createExtensionSkill(env, "self-hosted", "outsider", { name: "Private", description: "Secret", instructions: "Do not leak", enabled: true, workspaceId: "self-hosted" });
    const instance = host(env, session.agentName, { shibaWorkTarget: "app-tools" });
    const tools = instance.getTools();
    expect(Object.keys(tools)).not.toContain("run_code");
    expect(Object.keys(tools)).not.toContain("delegate_coding_task");
    const turn = await instance.beforeTurn({ tools, system: "base" } as never);
    expect(turn.activeTools).toEqual(["list_skills", "get_skill_instructions"]);
    expect(turn.instructions).toContain("Style: Short drafts");
    expect(turn.instructions).not.toContain("Write short paragraphs.");
    expect(turn.instructions).not.toContain("Private: Secret");
    expect(await execute(tools, "list_skills", {})).toEqual([{ _id: skillId, name: "Style", description: "Short drafts", enabled: true, version: 1 }]);
    expect(await execute(tools, "get_skill_instructions", { skillId, expectedVersion: 1 })).toMatchObject({ instructions: "Write short paragraphs.", version: 1 });
    await updateExtensionSkill(env, "self-hosted", owner, skillId, { enabled: false });
    expect(await execute(tools, "get_skill_instructions", { skillId })).toBeNull();
    sessions.rows = [];
    await expect(execute(tools, "list_skills", {})).rejects.toThrow("active owned employee session");
    expect((await instance.beforeTurn({ tools, system: "base" } as never)).activeTools).toEqual([]);
  });

  it("retains scoped read-only skill tools for both legacy and managed employees without restoring Code Mode after revoke", async () => {
    const env = { AGENT_AUDIT: customAgentD1().database } as unknown as Env;
    const employee = await createCustomAgent(env, "self-hosted", owner, { name: "Editor", instructions: "Edit prose", harness: "opencode" });
    await createExtensionSkill(env, "self-hosted", owner, { name: "Style", description: "Short drafts", instructions: "Write briefly", workspaceId: "self-hosted" });
    const instance = host(env, owner, { shibaTask: { customAgentId: employee.id, orgId: "self-hosted" } });
    const tools = { run_code: {}, employee_tool_catalog: {}, employee_tool_call: {}, list_skills: {}, get_skill_instructions: {} };
    const legacy = await instance.beforeTurn({ tools, system: "base" } as never);
    expect(legacy.activeTools).toEqual(["run_code", "list_skills", "get_skill_instructions"]);
    expect(legacy.instructions).toContain("Style: Short drafts");
    await updateCustomAgent(env, "self-hosted", employee.id, { ...employee.config, toolScopes: [] }, employee.version);
    const managed = await instance.beforeTurn({ tools, system: "base" } as never);
    expect(managed.activeTools).toEqual(["list_skills", "get_skill_instructions"]);
    expect(managed.instructions).toContain("never grant tools or approve actions");
  });

  it("keeps Chat tool-free and never guesses a Slack reader identity", async () => {
    const env = { AGENT_AUDIT: customAgentD1().database } as unknown as Env;
    const chat = host(env, owner, { shibaMode: "chat", shibaWorkTarget: "app-tools" });
    expect(chat.getTools()).toEqual({});
    expect((await chat.beforeTurn({ tools: { list_skills: {} }, system: "base" } as never)).activeTools).toEqual([]);
    const slack = host(env, "slack:T1:C1:123.000001", {});
    expect(slack.getTools().list_skills).toBeUndefined();
    expect(slack.getTools().get_skill_instructions).toBeUndefined();
  });
});
