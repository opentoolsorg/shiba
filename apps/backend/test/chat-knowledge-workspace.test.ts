import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { CodingOrchestrator } from "../src/agents/orchestrator.js";
import { insertFileRecord } from "../src/files/files-store.js";
import { runIngestionJob } from "../src/knowledge/knowledge-ingestion.js";
import { acceptTeamWorkspaceInvitation, createTeamWorkspace, createTeamWorkspaceInvitation } from "../src/team-workspaces-store.js";
import { buildSessionAgentName } from "../src/web-sessions.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

vi.mock("@cloudflare/think", () => ({ Think: class {} }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));

const ADA = "ada@example.test";
const BEN = "ben@example.test";

type ToolSet = Record<string, { execute: (input: unknown, options: unknown) => Promise<unknown> }>;

/**
 * Chat knowledge lookups must read the workspace the session was created in.
 * A dashboard orchestrator name is constant across workspaces, so the session's
 * server-assigned pin is the only trustworthy source — and an unpinned or
 * foreign session must find nothing.
 */
async function fixture(options: { withVectors?: boolean } = {}) {
  const { database } = customAgentD1();
  const objects = new Map<string, Uint8Array>();
  const env = {
    AGENT_AUDIT: database,
    FILES: { async get(key: string) { const bytes = objects.get(key); return bytes ? { arrayBuffer: async () => bytes.buffer } : null; } },
    AI: { run: vi.fn(async (_model: string, input: { text: string[] }) => ({ data: input.text.map(() => [0.1, 0.2]) })) },
    ...(options.withVectors === false ? {} : {
      MEMORY_VECTORS: { upsert: vi.fn(async () => {}), query: vi.fn(async () => ({ matches: [] })), deleteByIds: vi.fn(async () => {}) },
    }),
  } as unknown as Env;
  const workspace = await createTeamWorkspace(env, ADA, { name: "Knowledge" }, 1);
  const invite = await createTeamWorkspaceInvitation(env, workspace.workspaceId, ADA, { email: BEN, role: "member" }, 2);
  await acceptTeamWorkspaceInvitation(env, BEN, invite.token, 3);
  objects.set("plan.md", new TextEncoder().encode("Falcon rollout starts on 12 March."));
  const file = await insertFileRecord(env, {
    workspaceId: workspace.workspaceId, scope: "workspace", name: "falcon-plan.md", mime: "text/markdown",
    size: 31, r2Key: "plan.md", sha256: "a".repeat(64), createdBy: ADA,
  });
  await runIngestionJob(env, {
    jobId: "job-1", sourceKind: "file", sourceId: file.id, workspaceId: workspace.workspaceId, scope: "workspace",
    version: 1, sha256: file.sha256, r2Key: "plan.md", mime: "text/markdown",
  });
  function chatTools(user: string, sessionMetadata: Record<string, unknown> | null) {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const agentName = buildSessionAgentName(user, sessionId);
    const instance = Object.assign(Object.create(CodingOrchestrator.prototype) as object, {
      env,
      name: agentName,
      messages: [{ role: "user", id: "m1", metadata: { shibaMode: "chat" }, parts: [] }],
      state: {
        runs: [],
        webSessions: [{ id: sessionId, userId: user, name: "chat", agentName, createdAt: 1, updatedAt: 1,
          ...(sessionMetadata ? { metadata: sessionMetadata } : {}) }],
      },
      employeeToolProfileId: () => undefined,
    }) as unknown as CodingOrchestrator;
    return instance.getTools() as unknown as ToolSet;
  }
  return { env, workspaceId: workspace.workspaceId, chatTools };
}

const ask = (tools: ToolSet, query = "falcon") =>
  tools.knowledge_search!.execute({ query }, { toolCallId: "t", messages: [] }) as Promise<{
    ok: boolean; forbidden?: boolean; hits?: Array<{ sourceName?: string }>; message?: string;
  }>;

describe("chat knowledge lookup workspace", () => {
  afterEach(() => vi.restoreAllMocks());

  it("searches the team workspace pinned on the session", async () => {
    const f = await fixture();
    const tools = f.chatTools(ADA, { orgId: `team:${f.workspaceId}`, teamWorkspaceId: f.workspaceId, teamMembershipVersion: 1 });
    const result = await ask(tools);
    expect(result.ok).toBe(true);
    expect(result.hits?.map((hit) => hit.sourceName)).toEqual(["falcon-plan.md"]);
  });

  it("fails closed for a member-less viewer and for a session without a verified pin", async () => {
    const f = await fixture();
    const outsider = f.chatTools("eve@example.test", { orgId: `team:${f.workspaceId}`, teamWorkspaceId: f.workspaceId });
    expect(await ask(outsider)).toMatchObject({ ok: false, forbidden: true });
    const unpinned = f.chatTools(ADA, null);
    expect(await ask(unpinned)).toMatchObject({ ok: true, hits: [] });
  });

  it("still answers keyword-only when vector search is unavailable in the pinned workspace", async () => {
    const f = await fixture({ withVectors: false });
    const tools = f.chatTools(ADA, { orgId: `team:${f.workspaceId}`, teamWorkspaceId: f.workspaceId });
    const result = await ask(tools);
    expect(result.hits?.map((hit) => hit.sourceName)).toEqual(["falcon-plan.md"]);
  });
});
