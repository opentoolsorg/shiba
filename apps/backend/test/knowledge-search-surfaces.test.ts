import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { insertFileRecord } from "../src/files/files-store.js";
import { runIngestionJob } from "../src/knowledge/knowledge-ingestion.js";
import { ftsMatchExpression, hybridKnowledgeSearch } from "../src/knowledge/knowledge-search.js";
import { KNOWLEDGE_DEADLINE_MS, knowledgeWithinDeadline } from "../src/search-routes.js";
import { createToolRegistry } from "../src/mcp-gateway.js";
import { registerKnowledgeSearchTool } from "../src/knowledge/knowledge-tool.js";
import { handleSearch } from "../src/search-routes.js";
import { acceptTeamWorkspaceInvitation, createTeamWorkspace, createTeamWorkspaceInvitation } from "../src/team-workspaces-store.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const state = vi.hoisted(() => ({ userId: "ada@example.test" }));
vi.mock("../src/request-auth.js", async (original) => ({
  ...await original<typeof import("../src/request-auth.js")>(),
  resolveRequestIdentity: async () => ({ authorized: true, userId: state.userId }), isAuthorizedRequest: async () => true,
  resolveUserId: async () => state.userId,
}));

const ADA = "ada@example.test";
const BEN = "ben@example.test";
const databases: DatabaseSync[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

async function fixture(options: { semantic?: boolean } = {}) {
  const { database, sqlite } = customAgentD1();
  databases.push(sqlite);
  const objects = new Map<string, Uint8Array>();
  const vectors = new Map<string, { id: string }>();
  const env = {
    AGENT_AUDIT: database,
    FILES: { async get(key: string) { const bytes = objects.get(key); return bytes ? { arrayBuffer: async () => bytes.buffer } : null; } },
    AI: { run: vi.fn(async (_model: string, input: { text: string[] }) => ({ data: input.text.map(() => [0.1, 0.2, 0.3]) })) },
    MEMORY_VECTORS: {
      upsert: vi.fn(async (items: Array<{ id: string }>) => { for (const item of items) vectors.set(item.id, item); }),
      query: vi.fn(async () => ({ matches: options.semantic ? [...vectors.values()] : [] })),
      deleteByIds: vi.fn(async () => {}),
    },
  } as unknown as Env;
  const workspace = await createTeamWorkspace(env, ADA, { name: "Knowledge" }, 1);
  const invite = await createTeamWorkspaceInvitation(env, workspace.workspaceId, ADA, { email: BEN, role: "member" }, 2);
  await acceptTeamWorkspaceInvitation(env, BEN, invite.token, 3);
  async function add(name: string, scope: "personal" | "workspace", body: string, workspaceId = workspace.workspaceId) {
    objects.set(name, new TextEncoder().encode(body));
    const file = await insertFileRecord(env, {
      workspaceId, scope, name, mime: "text/markdown", size: body.length, r2Key: name, sha256: "a".repeat(64), createdBy: ADA,
    });
    await runIngestionJob(env, {
      jobId: `job-${name}`, sourceKind: "file", sourceId: file.id, workspaceId, scope, version: 1,
      sha256: file.sha256, r2Key: name, mime: "text/markdown",
    });
    return file;
  }
  return { env, workspaceId: workspace.workspaceId, add };
}

describe("knowledge search hardening", () => {
  it("quotes every word so user punctuation never reaches FTS5 as syntax", () => {
    expect(ftsMatchExpression('pricing: "Q3" -draft OR (NEAR)')).toBe('"pricing" OR "q3" OR "draft" OR "or" OR "near"');
    expect(ftsMatchExpression("?!: --")).toBeNull();
  });

  it("finds a passage for a punctuated query, names its source, and works keyword-only without Vectorize", async () => {
    const f = await fixture();
    await f.add("launch-plan.md", "workspace", "The Falcon launch ships on 12 March with a staged rollout.");
    const hits = await hybridKnowledgeSearch(f.env, BEN, f.workspaceId, 'falcon "launch"?', 5);
    expect(hits).toMatchObject([{ sourceName: "launch-plan.md", scope: "workspace", rank: 1 }]);
    const keywordOnly = await hybridKnowledgeSearch({ ...f.env, AI: undefined, MEMORY_VECTORS: undefined } as unknown as Env, BEN, f.workspaceId, "falcon", 5);
    expect(keywordOnly).toHaveLength(1);
  });

  it("indexes searchable text inside note raw-text fallback markup", async () => {
    const f = await fixture();
    await f.add(
      "note-roundtrip.md",
      "workspace",
      "<span data-shiba-raw>visit https\\://example.com now</span>\n\n<code data-shiba-raw>open https\\://example.com&#10;then dev\\@example.com</code>\n",
    );
    for (const query of ["visit", "example", "then", "dev"]) {
      const hits = await hybridKnowledgeSearch(f.env, BEN, f.workspaceId, query, 5);
      expect(hits.map((hit) => hit.sourceName)).toContain("note-roundtrip.md");
    }
  });

  it("keeps semantic-only matches and still hides another user's personal source", async () => {
    const f = await fixture({ semantic: true });
    await f.add("ada-private.md", "personal", "Salary bands for the design team.");
    await f.add("handbook.md", "workspace", "Expense policy for travel.");
    const ada = await hybridKnowledgeSearch(f.env, ADA, f.workspaceId, "compensation", 10);
    expect(ada.map((hit) => hit.sourceName).sort()).toEqual(["ada-private.md", "handbook.md"]);
    const ben = await hybridKnowledgeSearch(f.env, BEN, f.workspaceId, "compensation", 10);
    expect(ben.map((hit) => hit.sourceName)).toEqual(["handbook.md"]);
  });
});

describe("knowledge in workspace search", () => {
  const ask = (env: Env, workspaceId: string, userId: string, types?: string) => {
    state.userId = userId;
    const query = types === undefined ? "" : `&types=${types}`;
    return handleSearch(new Request(`https://dashboard.test/api/search?q=falcon${query}`, { headers: { "X-Shiba-Workspace": workspaceId } }), env);
  };

  it("returns knowledge hits when asked, scoped to what the viewer may read", async () => {
    const f = await fixture();
    await f.add("launch-plan.md", "workspace", "Falcon launch checklist.");
    await f.add("ada-notes.md", "personal", "Falcon private retro notes.");
    const ada = await (await ask(f.env, f.workspaceId, ADA, "knowledge"))?.json() as { knowledge: Array<{ sourceName: string; snippet: string; sourceKind: string }>; tasks: unknown[] };
    expect(ada.knowledge.map((hit) => hit.sourceName).sort()).toEqual(["ada-notes.md", "launch-plan.md"]);
    expect(ada.knowledge[0]).toMatchObject({ sourceKind: "file" });
    expect(ada.tasks).toEqual([]);
    const ben = await (await ask(f.env, f.workspaceId, BEN, "chats,knowledge"))?.json() as { knowledge: Array<{ sourceName: string }> };
    expect(ben.knowledge.map((hit) => hit.sourceName)).toEqual(["launch-plan.md"]);
    const defaults = await (await ask(f.env, f.workspaceId, BEN))?.json() as { knowledge: unknown[] };
    expect(defaults.knowledge).toHaveLength(1);
    const omitted = await (await ask(f.env, f.workspaceId, BEN, "chats,tasks"))?.json() as { knowledge: unknown[] };
    expect(omitted.knowledge).toEqual([]);
  });

  it("does not fail task and chat search when knowledge storage errors", async () => {
    const f = await fixture();
    const env = { ...f.env, AI: { run: async () => { throw new Error("ai down"); } } } as unknown as Env;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await ask(env, f.workspaceId, ADA, "tasks,knowledge");
    expect(response?.status).toBe(200);
  });
});

describe("knowledge_search MCP tool", () => {
  it("searches the caller's workspace as the calling principal", async () => {
    const f = await fixture();
    await f.add("launch-plan.md", "workspace", "Falcon launch checklist.");
    const registry = createToolRegistry(f.env);
    registerKnowledgeSearchTool(registry, f.env);
    const tool = registry.tools().find((entry) => entry.name === "knowledge_search");
    const result = await tool!.handler({ query: "falcon" }, { principal: { principal: BEN, orgId: `team:${f.workspaceId}` } } as never);
    const body = JSON.parse((result.content[0] as { text: string }).text) as { hits: Array<{ sourceName: string }> };
    expect(body.hits.map((hit) => hit.sourceName)).toEqual(["launch-plan.md"]);
    const outsider = await tool!.handler({ query: "falcon" }, { principal: { principal: "eve@example.test", orgId: `team:${f.workspaceId}` } } as never);
    expect(JSON.parse((outsider.content[0] as { text: string }).text).hits).toEqual([]);
  });
});

describe("palette knowledge deadline", () => {
  it("returns knowledge hits when the embedding answers in time", async () => {
    await expect(knowledgeWithinDeadline(Promise.resolve([{ chunkId: "c1" }] as never))).resolves.toEqual([{ chunkId: "c1" }]);
  });

  it("yields an empty list rather than hold the palette on a stalled embedding", async () => {
    const started = Date.now();
    await expect(knowledgeWithinDeadline(new Promise(() => {}))).resolves.toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(KNOWLEDGE_DEADLINE_MS - 20);
  });

  it("still answers task search when the knowledge branch stalls", async () => {
    const f = await fixture();
    const stall = { ...f.env, AI: { run: () => new Promise(() => {}) } } as unknown as Env;
    const started = Date.now();
    const response = await handleSearch(new Request("https://dashboard.test/api/search?q=falcon&types=tasks,knowledge", {
      headers: { "X-Shiba-Workspace": f.workspaceId },
    }), stall);
    expect(response?.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(KNOWLEDGE_DEADLINE_MS + 1500);
    expect((await response?.json() as { knowledge: unknown[] }).knowledge).toEqual([]);
  });
});
