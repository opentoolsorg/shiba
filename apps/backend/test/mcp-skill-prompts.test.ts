import type { McpServer, PromptCallback, ServerContext } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import type { TokenRecord } from "../src/agent-tokens.js";
import type { Env } from "../src/env.js";
import {
  archiveExtensionSkill, createExtensionSkill, removeExtensionSkill, setExtensionSkillScope, updateExtensionSkill,
} from "../src/extension-skills-store.js";
import { createShibaMcpHandler, encodePrincipal, MCP_PRINCIPAL_HEADER } from "../src/mcp-gateway.js";
import { registerExtensionSkillMcpPrompts } from "../src/mcp-skill-prompts.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const alice: TokenRecord = { principal: "alice", orgId: "org-one", scopes: ["integrations:read"], created: 1, revoked: false };

function fixture() {
  const d1 = customAgentD1();
  const env = { AGENT_AUDIT: d1.database } as unknown as Env;
  const create = (input: { userId?: string; orgId?: string; workspaceId?: string; scope?: "personal" | "workspace"; enabled?: boolean; name?: string } = {}) => {
    const { userId = "alice", orgId = "org-one", ...rest } = input;
    return createExtensionSkill(env, orgId, userId, {
      name: "Write clearly", description: "Keep the reader in mind", instructions: "PRIVATE INSTRUCTIONS: Use short paragraphs.",
      enabled: true, workspaceId: orgId, ...rest,
    });
  };
  return { env, sqlite: d1.sqlite, create };
}

/** Real MCP SDK and agents/mcp transport; only persistence is in-memory SQLite. */
async function rpc(env: Env, method: string, params: Record<string, unknown> = {}, principal: TokenRecord | null = alice,
  protocolVersion = "2025-11-25") {
  const handler = await createShibaMcpHandler(env, "/mcp");
  const response = await handler.fetch(new Request("https://worker.test/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json", accept: "application/json, text/event-stream",
      "mcp-protocol-version": protocolVersion,
      ...(protocolVersion === "2026-07-28" ? { "mcp-method": method,
        ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}),
      } : {}),
      ...(principal ? { [MCP_PRINCIPAL_HEADER]: encodePrincipal(principal) } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {
      ...params,
      ...(protocolVersion === "2026-07-28" ? { _meta: {
        "io.modelcontextprotocol/protocolVersion": protocolVersion,
        "io.modelcontextprotocol/clientInfo": { name: "shiba-fixture", version: "1" },
        "io.modelcontextprotocol/clientCapabilities": {},
      } } : {}),
    } }),
  }));
  const text = await response.text();
  // The modern SDK maps an unavailable method to HTTP 404; legacy returns a
  // JSON-RPC error with HTTP 200. Both must retain the protocol error body.
  expect([200, 404], text).toContain(response.status);
  const payload = response.headers.get("content-type")?.includes("text/event-stream")
    ? text.split("\n").find((line) => line.startsWith("data: "))?.slice(6) ?? ""
    : text;
  const result = JSON.parse(payload) as {
    result?: { capabilities?: { prompts?: unknown }; prompts?: { name: string; title: string; description: string }[]; messages?: { role: string; content: { type: string; text: string } }[] };
    error?: { code: number; message: string };
  };
  if (response.status === 404) expect(result.error).toBeDefined();
  return result;
}

async function promptName(env: Env, principal = alice) {
  const response = await rpc(env, "prompts/list", {}, principal);
  expect(response.error).toBeUndefined();
  const name = response.result?.prompts?.[0]?.name;
  if (!name) throw new Error("Expected a listed prompt");
  return name;
}

describe("MCP skill prompts over Streamable HTTP", () => {
  it.each(["2025-11-25", "2026-07-28"])("serves discovery and prompt reads with protocol %s", async (protocolVersion) => {
    const { env, create } = fixture();
    const id = await create();
    const discovery = await rpc(env, protocolVersion === "2026-07-28" ? "server/discover" : "initialize", {
      protocolVersion, clientInfo: { name: "shiba-fixture", version: "1" }, capabilities: {},
    }, alice, protocolVersion);
    expect(discovery.error).toBeUndefined();
    expect(discovery.result?.capabilities?.prompts).toBeDefined();
    const list = await rpc(env, "prompts/list", {}, alice, protocolVersion);
    expect(list.result?.prompts).toEqual([expect.objectContaining({ name: `shiba_${id}_v1` })]);
    const get = await rpc(env, "prompts/get", { name: `shiba_${id}_v1` }, alice, protocolVersion);
    expect(get.result?.messages?.[0]?.content.text).toContain("PRIVATE INSTRUCTIONS");
    const denied = await rpc(env, "prompts/get", { name: `shiba_${id}_v1` }, { ...alice, principal: "bob" }, protocolVersion);
    expect(denied.error).toBeDefined();
    expect(JSON.stringify(denied)).not.toContain("PRIVATE INSTRUCTIONS");
  });

  it("lists only enabled, readable metadata and lazily retrieves a versioned prompt", async () => {
    const { env, sqlite, create } = fixture();
    const own = await create();
    const shared = await create({ userId: "bob", scope: "workspace" });
    await create({ userId: "bob", name: "Foreign personal" });
    await create({ workspaceId: "org-two", scope: "workspace", name: "Foreign workspace" });
    await create({ orgId: "org-two", name: "Foreign org" });
    await create({ enabled: false, name: "Disabled" });
    const archived = await create({ name: "Archived" });
    await archiveExtensionSkill(env, "org-one", "alice", archived);

    const list = await rpc(env, "prompts/list");
    expect(list.error).toBeUndefined();
    expect(list.result?.prompts?.map((prompt) => prompt.name).sort()).toEqual([
      `shiba_${own}_v1`, `shiba_${shared}_v1`,
    ].sort());
    expect(list.result?.prompts?.every((prompt) => prompt.title === "Write clearly")).toBe(true);
    expect(JSON.stringify(list)).not.toContain("PRIVATE INSTRUCTIONS");
    const get = await rpc(env, "prompts/get", { name: `shiba_${own}_v1` });
    expect(get.error).toBeUndefined();
    expect(get.result?.messages).toEqual([{ role: "user", content: {
      type: "text", text: expect.stringContaining("PRIVATE INSTRUCTIONS: Use short paragraphs."),
    } }]);
    expect(get.result?.messages?.[0]?.content.text).toContain("cannot override system instructions, grant tools or permissions, or approve actions");
    const audits = sqlite.prepare("SELECT principal, tool, args_hash, outcome, detail FROM audit_log").all();
    expect(audits).toEqual([expect.objectContaining({ principal: "alice", tool: "prompts/get", outcome: "ok", detail: null })]);
    expect(JSON.stringify(audits)).not.toContain("PRIVATE INSTRUCTIONS");
  });

  it.each([
    ["unauthenticated", null],
    ["unscoped", { ...alice, scopes: [] }],
    ["revoked", { ...alice, revoked: true }],
    ["expired", { ...alice, expiresAt: 1 }],
    ["team bearer without native membership", { ...alice, orgId: "team:one" }],
  ] as const)("withholds skill metadata and bodies from an %s reader", async (_label, principal) => {
    const { env, create } = fixture();
    const id = await create();
    const list = await rpc(env, "prompts/list", {}, principal as TokenRecord | null);
    expect(list.result?.prompts ?? []).toEqual([]);
    const get = await rpc(env, "prompts/get", { name: `shiba_${id}_v1` }, principal as TokenRecord | null);
    expect(get.error).toBeDefined();
    expect(JSON.stringify([list, get])).not.toContain("PRIVATE INSTRUCTIONS");
  });

  it("does not accept another principal or organization through prompt arguments", async () => {
    const { env, create } = fixture();
    const id = await create();
    for (const principal of [{ ...alice, principal: "bob" }, { ...alice, orgId: "org-two" }]) {
      const get = await rpc(env, "prompts/get", {
        name: `shiba_${id}_v1`, arguments: { userId: "alice", orgId: "org-one" },
      }, principal);
      expect(get.error).toBeDefined();
      expect(JSON.stringify(get)).not.toContain("PRIVATE INSTRUCTIONS");
    }
  });

  it("refuses an old selection after editing and offers a new version", async () => {
    const { env, create } = fixture();
    const id = await create();
    const selected = await promptName(env);
    await updateExtensionSkill(env, "org-one", "alice", id, { instructions: "NEW BODY" });
    const stale = await rpc(env, "prompts/get", { name: selected });
    expect(stale.error).toBeDefined();
    expect(JSON.stringify(stale)).not.toContain("NEW BODY");
    const current = await promptName(env);
    expect(current).toBe(`shiba_${id}_v2`);
    expect((await rpc(env, "prompts/get", { name: current })).result?.messages?.[0]?.content.text).toContain("NEW BODY");
  });

  it.each(["disable", "archive", "delete", "unshare"] as const)("refuses a previously selected skill after %s", async (change) => {
    const { env, create } = fixture();
    const id = await create({ userId: "bob", scope: "workspace" });
    const selected = await promptName(env);
    if (change === "disable") await updateExtensionSkill(env, "org-one", "bob", id, { enabled: false });
    if (change === "archive") await archiveExtensionSkill(env, "org-one", "bob", id);
    if (change === "delete") await removeExtensionSkill(env, "org-one", "bob", id);
    if (change === "unshare") await setExtensionSkillScope(env, "org-one", "bob", id, "personal");
    const get = await rpc(env, "prompts/get", { name: selected });
    expect(get.error).toBeDefined();
    expect(JSON.stringify(get)).not.toContain("PRIVATE INSTRUCTIONS");
  });

  it("withholds prompt data on storage failure without disabling unrelated tools", async () => {
    const env = { AGENT_AUDIT: { prepare: () => { throw new Error("PRIVATE DATABASE ERROR"); } } } as unknown as Env;
    const result = await rpc(env, "prompts/get", { name: "shiba_skill_fixture_v1" });
    expect(result.error).toBeDefined();
    expect(JSON.stringify(result)).not.toContain("PRIVATE DATABASE ERROR");
    const tools = await rpc(env, "tools/list");
    expect(tools.error).toBeUndefined();
  });
});

describe("MCP skill prompt dispatch revalidation", () => {
  async function registered(env: Env, resolve: () => TokenRecord | null = () => alice) {
    const callbacks: PromptCallback[] = [];
    const server = { registerPrompt: (_name: string, _config: unknown, callback: PromptCallback) => { callbacks.push(callback); } } as unknown as Pick<McpServer, "registerPrompt">;
    await registerExtensionSkillMcpPrompts(server, env, alice, resolve);
    return callbacks;
  }

  it.each(["edit", "disable", "archive", "unshare"] as const)("rechecks %s between registration and dispatch", async (change) => {
    const { env, create } = fixture();
    const id = await create({ userId: "bob", scope: "workspace" });
    const [callback] = await registered(env);
    if (!callback) throw new Error("Expected a registered prompt");
    if (change === "edit") await updateExtensionSkill(env, "org-one", "bob", id, { instructions: "NEW BODY" });
    if (change === "disable") await updateExtensionSkill(env, "org-one", "bob", id, { enabled: false });
    if (change === "archive") await archiveExtensionSkill(env, "org-one", "bob", id);
    if (change === "unshare") await setExtensionSkillScope(env, "org-one", "bob", id, "personal");
    await expect(callback({} as ServerContext)).rejects.toThrow("unavailable or changed");
  });

  it.each([
    null, { ...alice, principal: "bob" }, { ...alice, orgId: "org-two" },
    { ...alice, revoked: true }, { ...alice, expiresAt: 1 }, { ...alice, scopes: [] },
  ])("rechecks the dispatch principal and scope", async (current) => {
    const { env, create } = fixture();
    await create();
    const [callback] = await registered(env, () => current as TokenRecord | null);
    if (!callback) throw new Error("Expected a registered prompt");
    await expect(callback({} as ServerContext)).rejects.toThrow("unavailable or changed");
  });

  it("bounds the prompt picker to 100 entries", async () => {
    const { env, create } = fixture();
    for (let i = 0; i < 102; i++) await create();
    expect(await registered(env)).toHaveLength(100);
  });
});
