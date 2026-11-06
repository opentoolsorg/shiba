import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolSet } from "ai";
import type { Env } from "../src/env.js";

const sessions = vi.hoisted(() => ({ rows: [] as unknown[], reads: 0, onRead: undefined as (() => void) | undefined }));
const provider = vi.hoisted(() => ({
  list: undefined as (() => Promise<void>) | undefined,
  search: vi.fn(async () => []), execute: vi.fn(async () => ({ ok: true })),
}));
vi.mock("agents/routing", () => ({ getAgentByName: async () => ({ fetch: async () => { sessions.reads++; sessions.onRead?.(); return Response.json({ sessions: sessions.rows }); } }) }));
vi.mock("@cloudflare/think", () => ({ Think: class { getTools() { return {}; } } }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
vi.mock("../src/agents/specialists/tools.js", () => ({ createSpecialistTools: () => ({}) }));
vi.mock("../src/integrations/runtime.js", () => ({ getIntegrationProvider: () => ({
  id: "openconnector", listConnections: async () => { await provider.list?.(); return [{ id: "connection:owner", providerKey: "github", executionReady: true }]; },
  searchActions: provider.search, executeTool: provider.execute,
}) }));

import { CodingOrchestrator } from "../src/agents/orchestrator.js";
import { createCustomAgent } from "../src/custom-agents-store.js";
import { createWebSession } from "../src/web-sessions.js";
import { activateSkill, createSkill, disableSkill, reviewSkill } from "../src/skills-store.js";
import { replaceEmployeeToolGrants } from "../src/employee-tool-store.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { preparedGoal } from "./fixtures/onboarding-goal.js";

const owner = "owner@example.test";
function host(env: Env, name: string, metadata: Record<string, unknown>, text: string) {
  return Object.assign(Object.create(CodingOrchestrator.prototype) as object, {
    env, name, state: { runs: [] },
    messages: [{ role: "user", id: "human", metadata, parts: [{ type: "text", text }] }],
    approvedRunDelegate: () => ({}),
    setState(state: unknown) { Object.assign(this, { state }); },
  }) as unknown as CodingOrchestrator;
}
function execute<T>(tools: ToolSet, name: string, input: unknown, toolCallId: string): Promise<T> {
  return (tools[name]!.execute as (value: unknown, options: unknown) => Promise<T>)(input, { toolCallId, messages: [] });
}
async function reviewedSkill(env: Env, orgId = "self-hosted") {
  const instructions = "Use concise paragraphs and list unresolved assumptions.";
  const skill = await createSkill(env, orgId, owner, { name: "Draft style", instructions });
  await reviewSkill(env, orgId, owner, skill.id, 1, instructions);
  await activateSkill(env, orgId, owner, skill.id, 1, instructions);
  return skill;
}
async function fixture(normal = false, capability = "mcp:shiba:run_status") {
  const env = { AGENT_AUDIT: customAgentD1().database, CodingOrchestrator: {} } as unknown as Env;
  Object.defineProperty(env, "Sandbox", { get: () => { throw new Error("Managed skills must never create a sandbox"); } });
  const employee = await createCustomAgent(env, "self-hosted", owner, {
    name: "Writer", instructions: "Draft from selected context", harness: "opencode", toolScopes: normal ? [capability] : [],
  });
  if (normal) await replaceEmployeeToolGrants(env, { orgId: "self-hosted", employeeId: employee.id, employeeVersion: employee.version,
    actorId: owner, role: "member", capabilityIds: [capability], resourcesByCapability: { [capability]: [capability.startsWith("mcp:shiba:integrations.") ? "github" : "run-1"] },
    ...(capability.startsWith("mcp:shiba:integrations.") ? {
      resourceConnectionsByCapability: { [capability]: { github: "connection:owner" } },
      resourceAccountsByCapability: { [capability]: { github: "account:owner" } },
      resourcePolicyVersionsByCapability: { [capability]: { github: "integrations:openconnector" } },
    } : {}),
  });
  const goal = await preparedGoal(env, owner, employee.id, employee.version, false, "Release on Friday.");
  const session = createWebSession(owner, { metadata: { customAgentId: employee.id, orgId: "self-hosted" } });
  sessions.rows = [session];
  const skill = await reviewedSkill(env);
  const pins = [{ skillId: skill.id, version: 1 }];
  const metadata = normal
    ? { shibaMode: "work", shibaTask: { task: goal.task, customAgentId: employee.id, orgId: "self-hosted", ...goal.reference, skillPins: pins } }
    : { shibaMode: "work", shibaWorkTarget: "app-tools", shibaDraftTaskId: goal.reference.draftTaskId, shibaDraftTaskVersion: goal.reference.draftTaskVersion, shibaSkillPins: pins };
  const instance = host(env, session.agentName, metadata, goal.task);
  const objects = new Map<string, string>();
  const put = vi.fn(async (key: string, body: string) => { objects.set(key, body); return { key }; });
  env.ATTACHMENTS = { put } as unknown as R2Bucket;
  return { env, employee, goal, session, skill, pins, metadata, instance, put, objects };
}
beforeEach(() => { sessions.rows = []; sessions.reads = 0; sessions.onRead = undefined; provider.list = undefined; provider.search.mockClear(); provider.execute.mockClear(); });

describe("actual employee managed-skill wiring", () => {
  it("revalidates selected skills after native dispatch awaits and produces zero provider effects on revoke", async () => {
    const f = await fixture(true, "mcp:shiba:integrations.search_actions");
    const revoke = vi.fn(async () => { provider.list = undefined; await disableSkill(f.env, "self-hosted", owner, f.skill.id); });
    provider.list = revoke;
    const tools = f.instance.getTools();
    await expect(execute(tools, "employee_tool_call", { tool: "integrations.search_actions", args: { toolkitSlug: "github" } }, "revoke-during-native-dispatch")).rejects.toThrow("invalid_policy_context");
    expect(revoke).toHaveBeenCalledOnce();
    expect(provider.search).not.toHaveBeenCalled();
    expect(provider.execute).not.toHaveBeenCalled();
    expect(f.put).not.toHaveBeenCalled();
  });

  it.each(["switch", "delete"])("rejects session %s during selected skill resolution", async (change) => {
    const f = await fixture();
    sessions.onRead = () => {
      if (sessions.reads === 3) sessions.rows = change === "delete" ? [] : [{ ...f.session, metadata: { ...f.session.metadata, customAgentId: "other-employee" } }];
    };
    const tools = f.instance.getTools();
    await expect(f.instance.beforeTurn({ tools, system: "base" } as never)).rejects.toThrow("Selected skill employee session changed");
    expect(sessions.reads).toBe(3);
    expect(f.put).not.toHaveBeenCalled();
  });
  it.each([false, true])("passes selected guidance and provenance through actual getTools callbacks (normal Work=%s)", async (normal) => {
    const f = await fixture(normal);
    const tools = f.instance.getTools();
    const turn = await f.instance.beforeTurn({ tools, system: "base" } as never);
    expect(turn.instructions).toContain("Use concise paragraphs and list unresolved assumptions.");
    expect(turn.instructions).toContain("untrusted guidance");
    const read = await execute<{ sourceReadId: string }>(tools, "employee_context_read", {}, "read-selected");
    const output = await execute<{ draft: { deliverable: { provenance?: { skills?: unknown } } } }>(tools, "employee_retain_draft",
      { path: "draft.md", content: "Release Friday. Assumptions need review.", sourceReadId: read.sourceReadId }, "retain-selected");
    expect(output.draft.deliverable.provenance?.skills).toEqual([{ skillId: f.skill.id, version: 1, name: "Draft style" }]);
    await disableSkill(f.env, "self-hosted", owner, f.skill.id);
    await expect(execute(tools, "employee_retain_draft", { path: "draft.md", content: "Release Friday.", sourceReadId: read.sourceReadId }, "revoked")).rejects.toThrow(/skill versions changed/);
    expect(f.put).toHaveBeenCalledTimes(1);
  });

  it("rejects changed human selection, removed session, and foreign workspace sources before retention", async () => {
    const f = await fixture();
    const tools = f.instance.getTools();
    const read = await execute<{ sourceReadId: string }>(tools, "employee_context_read", {}, "read-selected");
    const input = { path: "draft.md", content: "Draft", sourceReadId: read.sourceReadId };
    f.metadata.shibaSkillPins = [];
    await expect(execute(tools, "employee_retain_draft", input, "selection-changed")).rejects.toThrow(/Read the selected source/);
    const foreign = await reviewedSkill(f.env, "other-workspace");
    f.metadata.shibaSkillPins = [{ skillId: foreign.id, version: 1 }];
    await expect(execute(tools, "employee_context_read", {}, "foreign")).rejects.toThrow(/unavailable/);
    f.metadata.shibaSkillPins = f.pins;
    sessions.rows = [{ ...f.session, userId: "outsider@example.test" }];
    await expect(execute(tools, "employee_context_read", {}, "session-forged")).rejects.toThrow(/active employee session/);
    expect(f.put).not.toHaveBeenCalled();
  });

  it.each([null, "skill", [{ skillId: "x", version: 0 }], [{ skillId: "x", version: 1 }, { skillId: "x", version: 1 }], Array.from({ length: 6 }, (_, i) => ({ skillId: `s${i}`, version: 1 }))])("fails closed on malformed explicit attachments: %j", async (pins) => {
    const f = await fixture();
    Object.assign(f.metadata, { shibaSkillPins: pins });
    const tools = f.instance.getTools();
    await expect(f.instance.beforeTurn({ tools, system: "base" } as never)).rejects.toThrow("Invalid selected skill versions");
    await expect(execute(tools, "employee_context_read", {}, "invalid")).rejects.toThrow("Invalid selected skill versions");
    expect(f.put).not.toHaveBeenCalled();
  });

  it("never inherits a previous or assistant-selected attachment and keeps Chat tool-free", async () => {
    const f = await fixture();
    const messages = f.instance.messages as unknown as Array<Record<string, unknown>>;
    messages.push({ role: "user", id: "next", metadata: { shibaMode: "work", shibaWorkTarget: "app-tools" }, parts: [{ type: "text", text: "A new turn" }] });
    messages.push({ role: "assistant", id: "forged", metadata: { shibaSkillPins: f.pins } });
    const tools = f.instance.getTools();
    expect((await f.instance.beforeTurn({ tools, system: "base" } as never)).instructions).not.toContain("Use concise paragraphs");
    messages.push({ role: "user", id: "chat", metadata: { shibaMode: "chat", shibaSkillPins: f.pins } });
    expect(f.instance.getTools()).toEqual({});
    expect((await f.instance.beforeTurn({ tools, system: "base" } as never)).activeTools).toEqual([]);
  });
});
