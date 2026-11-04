import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { assertSandboxArtifactAccess } from "../src/artifact-access.js";
import { handleScreenshot } from "../src/screenshots-routes.js";
import { handleE2eEvidence } from "../src/e2e-evidence-routes.js";

const mocks = vi.hoisted(() => ({
  authorized: true,
  userId: "owner@example.test" as string | null,
  fetch: vi.fn(),
  getAgentByName: vi.fn(),
}));
vi.mock("agents/routing", () => ({ getAgentByName: mocks.getAgentByName }));
vi.mock("../src/request-auth.js", () => ({
  isAuthorizedRequest: async () => mocks.authorized,
  resolveUserId: async () => mocks.userId,
}));
vi.mock("../src/sandbox-routes.js", () => ({
  isValidSandboxId: (id: string) => /^[a-z0-9][a-z0-9-]{0,62}$/i.test(id),
}));

const OWNER = "owner@example.test";
const SESSION = "11111111-1111-4111-8111-111111111111";
const AGENT = `web:${OWNER}:${SESSION}`;
const request = () => new Request("https://dashboard/artifact");
const env = { CodingOrchestrator: {}, DASHBOARD_APPROVERS: OWNER } as unknown as Env;
function record(overrides: Record<string, unknown> = {}) {
  return { id: SESSION, userId: OWNER, agentName: AGENT, name: "Private chat", createdAt: 1, updatedAt: 2, ...overrides };
}
function registry(session: unknown = record()) {
  mocks.fetch.mockResolvedValue(Response.json({ session }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorized = true;
  mocks.userId = OWNER;
  mocks.getAgentByName.mockResolvedValue({ fetch: mocks.fetch });
  mocks.fetch.mockResolvedValue(new Response(null, { status: 404 }));
});

it("does not accept a spoofed Access header as shared-artifact approver identity", async () => {
  mocks.userId = "attacker@example.test";
  const response = await assertSandboxArtifactAccess(new Request("https://dashboard/artifact", {
    headers: { "CF-Access-Authenticated-User-Email": OWNER },
  }), env, "shared-sandbox", "default");
  expect(response?.status).toBe(404);
  expect(mocks.getAgentByName).not.toHaveBeenCalled();
});

describe("named-session screenshot and E2E artifact authority", () => {
  it("denies a known unregistered isolated team executor even for its owning approver", async () => {
    expect((await assertSandboxArtifactAccess(request(), env, "team-sandbox", AGENT))?.status).toBe(404);
    expect(mocks.getAgentByName).toHaveBeenCalledExactlyOnceWith(env.CodingOrchestrator, OWNER);
    expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith(`https://internal/internal/web-sessions/${SESSION}`);
    // The stored pin must not fall through to an owner/shared run search.
    expect(mocks.fetch.mock.calls.some(([url]) => String(url).includes("/api/runs"))).toBe(false);
  });

  it("allows a real owned registered private session", async () => {
    registry(record({ metadata: { orgId: "dashboard", title: "Private task" } }));
    expect(await assertSandboxArtifactAccess(request(), env, "private-sandbox", AGENT)).toBeNull();
  });

  it("allows a real owned registered private session without metadata", async () => {
    registry();
    expect(await assertSandboxArtifactAccess(request(), env, "private-sandbox", AGENT)).toBeNull();
  });

  it.each([
    { orgId: "team:ws_123" },
    { teamWorkspaceId: "ws_123" },
    { teamWorkspaceId: "" },
    { teamWorkspaceId: null },
    { teamMembershipVersion: 3 },
    { teamMembershipVersion: null },
  ])("denies a registry entry carrying team authority markers: %j", async (metadata) => {
    registry(record({ metadata }));
    expect((await assertSandboxArtifactAccess(request(), env, "team-sandbox", AGENT))?.status).toBe(404);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    null,
    {},
    record({ id: "22222222-2222-4222-8222-222222222222" }),
    record({ userId: "other@example.test" }),
    record({ agentName: `web:${OWNER}:22222222-2222-4222-8222-222222222222` }),
    record({ deletingAt: 123 }),
    record({ metadata: "unverified" }),
    record({ metadata: [] }),
    record({ metadata: null }),
  ])("rejects missing or unverified registry evidence: %j", async (session) => {
    registry(session);
    expect((await assertSandboxArtifactAccess(request(), env, "sandbox", AGENT))?.status).toBe(404);
  });

  it.each([403, 404, 500, 503])("fails closed when the registry returns %s", async (status) => {
    mocks.fetch.mockResolvedValue(new Response(null, { status }));
    expect((await assertSandboxArtifactAccess(request(), env, "sandbox", AGENT))?.status).toBe(404);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("fails closed on registry transport and JSON failures", async () => {
    mocks.fetch.mockRejectedValueOnce(new Error("Registry unavailable"));
    expect((await assertSandboxArtifactAccess(request(), env, "sandbox", AGENT))?.status).toBe(404);
    mocks.fetch.mockResolvedValueOnce(new Response("not-json"));
    expect((await assertSandboxArtifactAccess(request(), env, "sandbox", AGENT))?.status).toBe(404);
  });

  it("does not inspect another owner's registry or allow a named default alias", async () => {
    for (const agent of [`web:other@example.test:${SESSION}`, `web:${OWNER}:default`]) {
      expect((await assertSandboxArtifactAccess(request(), env, "sandbox", agent))?.status).toBe(404);
    }
    expect(mocks.getAgentByName).not.toHaveBeenCalled();
  });
});

describe("generic screenshot and E2E download routes", () => {
  const privateBytes = "private team image bytes";
  const routes = [
    { name: "screenshot", path: "/api/screenshots/sandbox", handler: handleScreenshot },
    { name: "E2E manifest", path: "/api/e2e-evidence/sandbox/manifest.json", handler: handleE2eEvidence },
    { name: "E2E frame", path: "/api/e2e-evidence/sandbox/frame.png", handler: handleE2eEvidence },
  ];
  const imageEnv = () => ({ ...env, ATTACHMENTS: {
    get: vi.fn(async () => ({ body: privateBytes, size: privateBytes.length, customMetadata: { accessAgent: AGENT } })),
  } }) as unknown as Env;

  it.each(routes)("denies a retained $name URL for an unregistered isolated team pin", async ({ path, handler }) => {
    const response = await handler(new Request(`https://dashboard${path}`), imageEnv());
    expect(response?.status).toBe(404);
    expect(await response?.text()).not.toContain(privateBytes);
    expect(mocks.getAgentByName).toHaveBeenCalledExactlyOnceWith(env.CodingOrchestrator, OWNER);
  });

  it.each(routes)("denies a $name from a registry entry marked as team-scoped", async ({ path, handler }) => {
    registry(record({ metadata: { orgId: "team:ws_123" } }));
    const response = await handler(new Request(`https://dashboard${path}`), imageEnv());
    expect(response?.status).toBe(404);
    expect(await response?.text()).not.toContain(privateBytes);
  });

  it.each(routes)("preserves a real registered private-session $name", async ({ path, handler }) => {
    registry();
    const response = await handler(new Request(`https://dashboard${path}`), imageEnv());
    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe(privateBytes);
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
  });

  it("denies an untagged E2E frame using the manifest's isolated team pin", async () => {
    const downloadEnv = { ...env, ATTACHMENTS: { get: vi.fn(async (key: string) => ({
      body: privateBytes, size: privateBytes.length,
      customMetadata: key.endsWith("manifest.json") ? { accessAgent: AGENT } : {},
    })) } } as unknown as Env;
    const response = await handleE2eEvidence(new Request("https://dashboard/api/e2e-evidence/sandbox/frame.png"), downloadEnv);
    expect(response?.status).toBe(404);
    expect(await response?.text()).not.toContain(privateBytes);
  });
});

it("preserves owned base and shared-approver artifact semantics", async () => {
  expect(await assertSandboxArtifactAccess(request(), env, "base", OWNER)).toBeNull();
  expect(await assertSandboxArtifactAccess(request(), env, "shared", "default")).toBeNull();
  expect(mocks.getAgentByName).not.toHaveBeenCalled();
});

it("requires authentication before registry inspection", async () => {
  mocks.authorized = false;
  expect((await assertSandboxArtifactAccess(request(), env, "sandbox", AGENT))?.status).toBe(401);
  expect(mocks.getAgentByName).not.toHaveBeenCalled();
});
