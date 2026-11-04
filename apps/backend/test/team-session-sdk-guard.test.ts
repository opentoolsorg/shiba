import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import type { Env } from "../src/env.js";

const state = vi.hoisted(() => ({ session: null as { id: string; userId: string; metadata?: Record<string, unknown> } | null,
  names: [] as string[], forwarded: [] as Request[] }));
vi.mock("@cloudflare/sandbox", () => ({ Sandbox: class {}, ContainerProxy: class {}, proxyToSandbox: async () => null, getSandbox: vi.fn() }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
vi.mock("../src/agents/orchestrator.js", () => ({ CodingOrchestrator: class {} }));
vi.mock("agents/routing", () => ({ routeAgentRequest: async () => null, getAgentByName: async (_namespace: unknown, name: string) => {
  state.names.push(name);
  return { fetch: async (request: Request | string) => {
    const value = typeof request === "string" ? new Request(request) : request;
    if (new URL(value.url).pathname.startsWith("/internal/web-sessions/")) return state.session ? Response.json({ session: state.session }) : new Response(null, { status: 404 });
    state.forwarded.push(value); return Response.json({ forwarded: true });
  } };
} }));

const OWNER = "owner@example.test", SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", AUD = "sdk-team-scope-fixture";
const ISSUER = "https://sdk-team-scope.cloudflareaccess.com";
let cookieHeaders: (email: string) => Promise<Record<string, string>>;
let worker: (typeof import("../src/index.js"))["default"];
beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(publicKey), kid: "scope", alg: "RS256", use: "sig" };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === `${ISSUER}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
    throw new Error("Unexpected external request in isolated session guard test.");
  });
  cookieHeaders = async (email) => ({ "Cf-Access-Jwt-Assertion": await new SignJWT({ email }).setProtectedHeader({ alg: "RS256", kid: "scope" })
    .setIssuer(ISSUER).setAudience(AUD).setIssuedAt().setExpirationTime("5m").sign(privateKey) });
  worker = (await import("../src/index.js")).default;
}, 60_000);
beforeEach(() => { state.session = { id: SESSION, userId: OWNER }; state.names.length = 0; state.forwarded.length = 0; });
afterAll(() => vi.unstubAllGlobals());
const env = { ACCESS_AUD: AUD, CodingOrchestrator: {}, ASSETS: { fetch: async () => new Response("fixture") } } as unknown as Env;
async function send(owner = OWNER, selected = "") {
  return worker.fetch(new Request(`https://dashboard.test/agents/coding-orchestrator/${encodeURIComponent(`web:${owner}:${SESSION}`)}${selected}`, {
    headers: { ...await cookieHeaders(OWNER), Upgrade: "websocket", Origin: "https://dashboard.test" },
  }), env);
}

describe("private team sessions cannot use legacy SDK routing", () => {
  it.each([
    { orgId: `team:ws_${"a".repeat(24)}` },
    { teamWorkspaceId: `ws_${"a".repeat(24)}` },
    { orgId: "self-hosted", teamMembershipVersion: 1 },
  ])("denies server-tagged team session %j before forwarding, including explicit query selectors", async (metadata) => {
    state.session!.metadata = metadata;
    expect((await send()).status).toBe(403);
    expect((await send(OWNER, `?workspaceId=ws_${"a".repeat(24)}`)).status).toBe(403);
    expect(state.forwarded).toHaveLength(0);
    expect(state.names.every((name) => name === OWNER)).toBe(true);
  });
  it("preserves an owned legacy session and refuses foreign, missing, or mismatched registry records", async () => {
    expect((await send()).status).toBe(200); expect(state.forwarded).toHaveLength(1);
    state.forwarded.length = 0;
    expect((await send("other@example.test")).status).toBe(403);
    state.session = null; expect((await send()).status).toBe(404);
    state.session = { id: SESSION, userId: "other@example.test" }; expect((await send()).status).toBe(404);
    expect(state.forwarded).toHaveLength(0);
  });
});
