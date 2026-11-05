import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import worker from "../src/index.js";
import {
  createTeamWorkspace,
  createTeamWorkspaceInvitation,
} from "../src/team-workspaces-store.js";
import { TEST_ACCESS_AUD, verifiedAccessHeaders } from "./fixtures/access-identity.js";

const routing = vi.hoisted(() => ({ getAgentByName: vi.fn(), routeAgentRequest: vi.fn() }));
vi.mock("agents/routing", () => routing);
vi.mock("@cloudflare/sandbox", () => ({
  Sandbox: class {},
  ContainerProxy: class {},
  proxyToSandbox: vi.fn().mockResolvedValue(null),
  getSandbox: vi.fn(),
}));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
vi.mock("../src/agents/orchestrator.js", () => ({ CodingOrchestrator: class {} }));

const BASE = "https://team-ingress.example.test",
  OWNER = "owner@example.test",
  MEMBER = "member@example.test";
const databases: DatabaseSync[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const database of databases.splice(0)) database.close();
});

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  databases.push(sqlite);
  const bindValue = (value: unknown): never =>
    (value instanceof Date
      ? value.getTime()
      : typeof value === "boolean"
        ? Number(value)
        : (value ?? null)) as never;
  const prepared = (sql: string, params: unknown[] = []) => ({
    bind: (...args: unknown[]) => prepared(sql, args),
    async all() {
      const results = sqlite.prepare(sql).all(...params.map(bindValue));
      return {
        results,
        meta: { changes: Number(sqlite.prepare("SELECT changes() AS c").get()?.c) },
      };
    },
    async run() {
      return this.all();
    },
    async first() {
      return sqlite.prepare(sql).get(...params.map(bindValue)) ?? null;
    },
  });
  const database = {
    prepare: (sql: string) => prepared(sql),
    exec: (sql: string) => sqlite.exec(sql),
    async batch(statements: ReturnType<typeof prepared>[]) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.all());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  const send = vi.fn(async (_mail: unknown) => {});
  const memoryNames: string[] = [];
  const env = {
    AGENT_AUDIT: database,
    BETTER_AUTH_SECRET: "i".repeat(32),
    BETTER_AUTH_URL: BASE,
    BETTER_AUTH_BOOTSTRAP_TOKEN: "fixture-ingress-bootstrap",
    BETTER_AUTH_VERIFICATION_FROM: "auth@example.test",
    ACCESS_AUD: TEST_ACCESS_AUD,
    REQUIRE_ACCESS: "1",
    SEND_EMAIL: { send },
    CodingOrchestrator: {},
    Memory: {
      idFromName: (name: string) => {
        memoryNames.push(name);
        return name;
      },
      get: () => ({ fetch: async () => Response.json({ sources: ["Synthetic member source"] }) }),
    },
  } as unknown as Env;
  routing.getAgentByName.mockReset().mockImplementation(async () => {
    throw new Error("Unexpected orchestrator access");
  });
  routing.routeAgentRequest.mockReset().mockResolvedValue(null);
  // Email delivery is a binding fixture. No provider, credential or remote send is exercised.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Unexpected network access");
    }),
  );
  return { env, sqlite, send, memoryNames };
}

function request(
  path: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return new Request(`${BASE}${path}`, {
    method,
    headers: { origin: BASE, "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function cookies(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}
async function bootstrap(f: ReturnType<typeof fixture>) {
  const response = await worker.fetch(
    request(
      "/api/auth/sign-up/email",
      "POST",
      { name: "Owner", email: OWNER, password: "owner-password-123" },
      { "x-shiba-bootstrap-token": "fixture-ingress-bootstrap" },
    ),
    f.env,
  );
  expect(response.status).toBe(200);
  expect(f.send).not.toHaveBeenCalled();
  return cookies(response);
}
async function member(f: ReturnType<typeof fixture>) {
  const ownerCookie = await bootstrap(f);
  const workspace = await createTeamWorkspace(f.env, OWNER, { name: "Release team" });
  const invitation = await createTeamWorkspaceInvitation(f.env, workspace.workspaceId, OWNER, {
    email: MEMBER,
    role: "member",
  });
  const registered = await worker.fetch(
    request(
      "/api/auth/sign-up/email",
      "POST",
      { name: "Member", email: MEMBER, password: "member-password-456", callbackURL: "/app/" },
      { "x-shiba-workspace-invitation": invitation.token },
    ),
    f.env,
  );
  expect(registered.status).toBe(200);
  const mail = f.send.mock.calls[0]?.[0] as { text?: string } | undefined;
  const verificationUrl = mail?.text?.match(/https:\/\/\S+/)?.[0];
  if (!verificationUrl) throw new Error("Fixture verification email is missing its URL.");
  expect((await worker.fetch(new Request(verificationUrl), f.env)).status).toBe(302);
  const cookie = cookies(registered);
  const accepted = await worker.fetch(
    request("/api/workspaces/invitations/accept", "POST", { token: invitation.token }, { cookie }),
    f.env,
  );
  expect(accepted.status).toBe(200);
  return { workspace, cookie, ownerCookie };
}

describe("full Worker ingress for restricted native team members", () => {
  it("routes funded text through native member policy without a legacy orchestrator or implicit billing", async () => {
    const f = fixture(), m = await member(f);
    const anonymousProbe = await worker.fetch(request("/api/__shiba_preview_auth_probe__"), f.env);
    expect(anonymousProbe.status).toBe(401);
    const path = "/api/team-model-sessions/state?roomId=not-a-room";
    const missingWorkspace = await worker.fetch(request(path, "GET", undefined, { cookie: m.cookie }), f.env);
    expect(missingWorkspace.status).toBe(403);
    const response = await worker.fetch(request(path, "GET", undefined, {
      cookie: m.cookie, "X-Shiba-Workspace": m.workspace.workspaceId,
    }), f.env);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "team_model_room_required" });
    const operatorRoute = await worker.fetch(request("/api/providers/codex/connect", "POST", {}, {
      cookie: m.cookie, "X-Shiba-Workspace": m.workspace.workspaceId,
    }), f.env);
    expect(operatorRoute.status).toBe(403);
    expect(routing.getAgentByName).not.toHaveBeenCalled();
    expect(routing.routeAgentRequest).not.toHaveBeenCalled();
  });

  it("strips a forged Access owner identity before policy even when the invited account is verified", async () => {
    const f = fixture(),
      m = await member(f);
    const headers = {
      cookie: m.cookie,
      "X-Shiba-Workspace": m.workspace.workspaceId,
      "CF-Access-Authenticated-User-Email": OWNER,
    };
    const who = await worker.fetch(request("/api/whoami", "GET", undefined, headers), f.env);
    expect(await who.json()).toMatchObject({ agent: MEMBER, teamMember: true });
    for (const [path, method] of [
      ["/api/api-keys", "GET"],
      ["/api/unknown-admin", "GET"],
      ["/api/providers/codex/connect", "POST"],
      ["/oauth/authorize", "GET"],
      ["/mcp", "GET"],
    ] as const) {
      const response = await worker.fetch(
        request(path, method, method === "POST" ? { mode: "api-key" } : undefined, headers),
        f.env,
      );
      expect(response.status, path).toBe(403);
    }
    const malformedJwt = await worker.fetch(
      request("/api/api-keys", "GET", undefined, {
        ...headers,
        "Cf-Access-Jwt-Assertion": "forged.token.value",
      }),
      f.env,
    );
    expect(malformedJwt.status).toBe(403);
    expect(routing.getAgentByName).not.toHaveBeenCalled();
  });

  it("denies global approvals before any owner or shared-default orchestrator lookup", async () => {
    const f = fixture(),
      m = await member(f);
    // An occupational/workspace owner role does not change native account provenance.
    f.sqlite
      .prepare("UPDATE team_workspace_memberships SET role='owner' WHERE user_id=?")
      .run(MEMBER);
    const response = await worker.fetch(
      request("/api/approvals", "GET", undefined, {
        cookie: m.cookie,
        "X-Shiba-Workspace": m.workspace.workspaceId,
        "CF-Access-Authenticated-User-Email": OWNER,
      }),
      f.env,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "deployment_operator_required" });
    expect(routing.getAgentByName).not.toHaveBeenCalled();
    expect(routing.routeAgentRequest).not.toHaveBeenCalled();
  });

  it("preserves verified Access operator precedence while an invited cookie is also present", async () => {
    const f = fixture(),
      m = await member(f);
    const headers = await verifiedAccessHeaders(OWNER);
    const response = await worker.fetch(
      request("/api/whoami", "GET", undefined, { cookie: m.cookie, ...headers }),
      f.env,
    );
    const body = await response.json() as { agent: string; auth: "access" | "better-auth" | "none"; teamMember?: boolean };
    expect(body).toMatchObject({ agent: OWNER, auth: "access" });
    expect(body.teamMember).toBeUndefined();
    expect(routing.getAgentByName).not.toHaveBeenCalled();
  });

  it("cannot use an invitation for an existing owner email to replace its account or password", async () => {
    const f = fixture(),
      m = await member(f);
    const invitation = await createTeamWorkspaceInvitation(f.env, m.workspace.workspaceId, OWNER, {
      email: OWNER,
      role: "owner",
    });
    const before = f.sqlite
      .prepare('SELECT id,email,emailVerified FROM "user" WHERE email=?')
      .get(OWNER);
    const signup = await worker.fetch(
      request(
        "/api/auth/sign-up/email",
        "POST",
        {
          name: "Claimed owner",
          email: OWNER,
          password: "replacement-password-123",
          emailVerified: true,
        },
        { "x-shiba-workspace-invitation": invitation.token },
      ),
      f.env,
    );
    expect(signup.status).toBe(422);
    expect(cookies(signup)).toBe("");
    expect(
      f.sqlite.prepare('SELECT id,email,emailVerified FROM "user" WHERE email=?').get(OWNER),
    ).toEqual(before);
    const badSignIn = await worker.fetch(
      request("/api/auth/sign-in/email", "POST", {
        email: OWNER,
        password: "replacement-password-123",
      }),
      f.env,
    );
    expect(badSignIn.status).toBe(401);
    const who = await worker.fetch(
      request("/api/whoami", "GET", undefined, { cookie: m.cookie }),
      f.env,
    );
    expect(await who.json()).toMatchObject({ agent: MEMBER, teamMember: true });
    expect(
      f.sqlite.prepare("SELECT email FROM shiba_auth_account_policy WHERE kind='bootstrap'").all(),
    ).toEqual([{ email: OWNER }]);
  });

  it("self-invitation cannot promote an existing invited identity or redirect its private memory", async () => {
    const f = fixture(),
      m = await member(f);
    const ownWorkspace = await createTeamWorkspace(f.env, MEMBER, {
      name: "Member's own workspace",
    });
    const invitation = await createTeamWorkspaceInvitation(
      f.env,
      ownWorkspace.workspaceId,
      MEMBER,
      { email: MEMBER, role: "owner" },
    );
    const accepted = await worker.fetch(
      request(
        "/api/workspaces/invitations/accept",
        "POST",
        { token: invitation.token },
        { cookie: m.cookie },
      ),
      f.env,
    );
    expect(accepted.status).toBe(404);
    expect(
      f.sqlite.prepare("SELECT kind FROM shiba_auth_account_policy WHERE email=?").get(MEMBER)
        ?.kind,
    ).toBe("invited");
    const headers = {
      cookie: m.cookie,
      "X-Shiba-Workspace": ownWorkspace.workspaceId,
      "CF-Access-Authenticated-User-Email": OWNER,
    };
    expect(
      (await worker.fetch(request("/api/api-keys", "GET", undefined, headers), f.env)).status,
    ).toBe(403);
    const memory = await worker.fetch(
      request(`/api/memory/sources?owner=${encodeURIComponent(OWNER)}`, "GET", undefined, headers),
      f.env,
    );
    expect(memory.status).toBe(200);
    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(MEMBER))),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    expect(f.memoryNames).toEqual([`owner-memory:${hash}`]);
    expect(await memory.json()).toMatchObject({ sources: ["Synthetic member source"] });
    expect(routing.getAgentByName).not.toHaveBeenCalled();
  });
});
