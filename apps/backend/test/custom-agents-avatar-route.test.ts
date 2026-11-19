import { beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_AVATAR_COATS, AGENT_AVATAR_VARIANTS } from "@shiba/shared";
import type { Env } from "../src/env.js";
import { handleCustomAgents } from "../src/custom-agents-routes.js";
import { getCustomAgentById } from "../src/custom-agents-store.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const authState = vi.hoisted(() => ({ dashboard: false }));

vi.mock("../src/request-auth.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/request-auth.js")>(),
  isAuthorizedRequest: vi.fn(async () => authState.dashboard),
  resolveUserId: vi.fn(async () => authState.dashboard ? "owner@example.test" : null),
}));

vi.mock("../src/v1-auth.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/v1-auth.js")>(),
  authorizeV1Request: vi.fn(async () => null),
}));

const config = { name: "Scout", instructions: "Read before changing code.", harness: "opencode" };
const variant = AGENT_AVATAR_VARIANTS[4]!;
const coat = AGENT_AVATAR_COATS[2]!;
const avatar = { kind: "variant", variant: variant.id, color: coat };

function env(): Env {
  return {
    AGENT_AUDIT: customAgentD1().database,
    SHIBA_SANDBOX_PROVIDER: "cloudflare",
    Sandbox: {} as unknown,
    AGENT_HARNESS: "opencode",
  } as Env;
}

const request = (path: string, method = "GET", body?: unknown) => new Request(`https://x/api/custom-agents${path}`, {
  method,
  headers: { "content-type": "application/json", origin: "https://x" },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

async function create(bindings: Env) {
  const response = await handleCustomAgents(request("", "POST", { slug: "scout", config }), bindings);
  expect(response?.status).toBe(201);
  return (await response!.json() as { agent: { id: string; version: number } }).agent;
}

beforeEach(() => {
  authState.dashboard = true;
});

describe("avatar through the custom-agent route", () => {
  it("saves a variant avatar and bumps the version", async () => {
    const bindings = env();
    const agent = await create(bindings);
    const response = await handleCustomAgents(request(`/${agent.id}`, "PATCH", { config: { ...config, avatar }, expectedVersion: agent.version }), bindings);
    expect(response?.status).toBe(200);
    const stored = await getCustomAgentById(bindings, "self-hosted", agent.id);
    expect(stored).toMatchObject({ version: 2, config: { avatar } });
  });

  it("refuses a stale expectedVersion and leaves the stored avatar alone", async () => {
    const bindings = env();
    const agent = await create(bindings);
    await handleCustomAgents(request(`/${agent.id}`, "PATCH", { config: { ...config, avatar }, expectedVersion: 1 }), bindings);
    const other = { kind: "variant", variant: AGENT_AVATAR_VARIANTS[9]!.id, color: AGENT_AVATAR_COATS[8]! };
    const conflict = await handleCustomAgents(request(`/${agent.id}`, "PATCH", { config: { ...config, avatar: other }, expectedVersion: 1 }), bindings);
    expect(conflict?.status).toBe(409);
    const stored = await getCustomAgentById(bindings, "self-hosted", agent.id);
    expect(stored).toMatchObject({ version: 2, config: { avatar } });
  });

  it("refuses an unknown variant, an off-palette coat and an upper-case coat", async () => {
    const bindings = env();
    const agent = await create(bindings);
    for (const bad of [
      { kind: "variant", variant: "not-a-variant", color: coat },
      { kind: "variant", variant: variant.id, color: "#123456" },
      { kind: "variant", variant: variant.id, color: coat.toUpperCase() },
      { kind: "sticker", id: "hero" },
    ]) {
      const response = await handleCustomAgents(request(`/${agent.id}`, "PATCH", { config: { ...config, avatar: bad }, expectedVersion: 1 }), bindings);
      expect(response?.status).toBe(400);
    }
    const stored = await getCustomAgentById(bindings, "self-hosted", agent.id);
    expect(stored?.version).toBe(1);
    expect(stored?.config).not.toHaveProperty("avatar");
  });

  it("strips extra keys instead of storing them", async () => {
    const bindings = env();
    const agent = await create(bindings);
    const response = await handleCustomAgents(request(`/${agent.id}`, "PATCH", {
      config: { ...config, avatar: { ...avatar, extra: "<svg onload=alert(1)>" } },
      expectedVersion: 1,
    }), bindings);
    expect(response?.status).toBe(200);
    const stored = await getCustomAgentById(bindings, "self-hosted", agent.id);
    expect(stored?.config.avatar).toEqual(avatar);
    expect(JSON.stringify(stored?.config)).not.toContain("onload");
  });

  it("refuses an upload reference on create and on update until the feature ships", async () => {
    const bindings = env();
    const upload = { kind: "upload", fileId: "file_abc12345" };
    const created = await handleCustomAgents(request("", "POST", { slug: "scout", config: { ...config, avatar: upload } }), bindings);
    expect(created?.status).toBe(400);
    expect(await created!.json()).toMatchObject({ error: "avatar_upload_unavailable" });
    const agent = await create(bindings);
    const updated = await handleCustomAgents(request(`/${agent.id}`, "PATCH", { config: { ...config, avatar: upload }, expectedVersion: 1 }), bindings);
    expect(updated?.status).toBe(400);
    expect(await updated!.json()).toMatchObject({ error: "avatar_upload_unavailable" });
  });
});
