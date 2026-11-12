import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { BETTER_AUTH_STATEMENTS, ensureBetterAuthSchema, handleBetterAuth, resolveBetterAuthUserId } from "../src/better-auth.js";
import type { Env } from "../src/env.js";
import { sendNativeEnrollmentVerification } from "../src/native-enrollment-email.js";
import { enforceTeamMemberApiPolicy, isRestrictedTeamMember, isTeamDeploymentOperator } from "../src/team-member-auth.js";
import { acceptTeamWorkspaceInvitation, createTeamWorkspace, createTeamWorkspaceInvitation, revokeTeamWorkspaceInvitation, validatePendingTeamInvitation } from "../src/team-workspaces-store.js";

const BASE = "https://team.example.test";
const owner = "owner@example.test", member = "member@example.test";
function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  const bindValue = (value: unknown): never => (value instanceof Date ? value.getTime() : typeof value === "boolean" ? Number(value) : value ?? null) as never;
  const prepared = (sql: string, params: unknown[] = []) => ({
    bind: (...args: unknown[]) => prepared(sql, args),
    async all() { const results = sqlite.prepare(sql).all(...params.map(bindValue)); return { results, meta: { changes: Number((sqlite.prepare("SELECT changes() AS c").get() as { c: number }).c) } }; },
    async run() { return this.all(); },
    async first() { return sqlite.prepare(sql).get(...params.map(bindValue)) ?? null; },
  });
  const database = { prepare: (sql: string) => prepared(sql), exec: (sql: string) => sqlite.exec(sql),
    async batch(statements: ReturnType<typeof prepared>[]) { sqlite.exec("BEGIN IMMEDIATE"); try { const result = []; for (const statement of statements) result.push(await statement.all()); sqlite.exec("COMMIT"); return result; } catch (error) { sqlite.exec("ROLLBACK"); throw error; } } } as unknown as D1Database;
  const send = vi.fn(async (_mail: unknown) => {});
  const env = { AGENT_AUDIT: database, BETTER_AUTH_SECRET: "e".repeat(32), BETTER_AUTH_URL: BASE,
    BETTER_AUTH_BOOTSTRAP_TOKEN: "local-fixture-bootstrap", BETTER_AUTH_VERIFICATION_FROM: "auth@example.test",
    SEND_EMAIL: { send } } as unknown as Env;
  return { sqlite, env, send };
}
const request = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => new Request(`${BASE}${path}`, {
  method, headers: { origin: BASE, "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const native = (req: Request, env: Env) => handleBetterAuth(req, env, { teamMemberPolicyEnabled: true });
function cookies(response: Response): string {
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}
async function bootstrap(f: ReturnType<typeof fixture>) {
  const response = (await native(request("/api/auth/sign-up/email", "POST", { name: "Owner", email: owner, password: "password-123" }, { "x-shiba-bootstrap-token": "local-fixture-bootstrap" }), f.env))!;
  expect(response.status).toBe(200);
  expect(f.send).not.toHaveBeenCalled();
  return cookies(response);
}
async function invited(f: ReturnType<typeof fixture>, email = member) {
  await bootstrap(f);
  const workspace = await createTeamWorkspace(f.env, owner, { name: "Product" });
  const invitation = await createTeamWorkspaceInvitation(f.env, workspace.workspaceId, owner, { email, role: "member" });
  const response = (await native(request("/api/auth/sign-up/email", "POST", { name: "Member", email, password: "password-456", callbackURL: "/app/?email_verified=1" }, { "x-shiba-workspace-invitation": invitation.token }), f.env))!;
  expect(response.status).toBe(200);
  const mail = f.send.mock.calls[0]![0] as { text: string };
  const url = mail.text.match(/https:\/\/\S+/)![0];
  return { workspace, invitation, response, cookie: cookies(response), verificationUrl: url };
}
async function verify(f: ReturnType<typeof fixture>, url: string) {
  const response = (await native(new Request(url), f.env))!;
  expect(response.status).toBe(302);
}

describe("invitation-only verified native enrollment", () => {
  it("preserves only the bootstrap owner and denies a raw invite's unverified email identity", async () => {
    const f = fixture();
    const setup = await invited(f);
    const sessionRequest = request("/api/whoami", "GET", undefined, { cookie: setup.cookie });
    expect(await resolveBetterAuthUserId(sessionRequest, f.env)).toBeNull();
    expect(await isRestrictedTeamMember(sessionRequest, f.env)).toBe(true);
    expect(await isTeamDeploymentOperator(sessionRequest, f.env)).toBe(false);
    expect(f.sqlite.prepare(`SELECT emailVerified FROM "user" WHERE email=?`).get(member)?.emailVerified).toBe(0);
    await verify(f, setup.verificationUrl);
    expect(await resolveBetterAuthUserId(sessionRequest, f.env)).toBe(member);
    // The same signed cached cookie must not override fresh verification revocation.
    f.sqlite.prepare(`UPDATE "user" SET emailVerified=0 WHERE email=?`).run(member);
    expect(await resolveBetterAuthUserId(sessionRequest, f.env)).toBeNull();
    f.sqlite.prepare(`UPDATE "user" SET emailVerified=1 WHERE email=?`).run(member);
    f.sqlite.prepare(`DELETE FROM "session" WHERE userId=(SELECT id FROM "user" WHERE email=?)`).run(member);
    expect(await resolveBetterAuthUserId(sessionRequest, f.env)).toBeNull();
  });

  it("requires exact recipient and current invitation, and does not consume it during enrollment", async () => {
    const f = fixture(); await bootstrap(f);
    const workspace = await createTeamWorkspace(f.env, owner, { name: "Team" });
    const invitation = await createTeamWorkspaceInvitation(f.env, workspace.workspaceId, owner, { email: member, role: "member" });
    expect(await validatePendingTeamInvitation(f.env, invitation.token, "other@example.test")).toBeNull();
    const wrong = await native(request("/api/auth/sign-up/email", "POST", { name: "Wrong", email: "victim@example.test", password: "password-456", emailVerified: true }, { "x-shiba-workspace-invitation": invitation.token }), f.env);
    expect(wrong?.status).toBe(403);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.sqlite.prepare(`SELECT COUNT(*) AS c FROM "user"`).get()?.c).toBe(1);
    expect((await validatePendingTeamInvitation(f.env, invitation.token, member))?.workspaceId).toBe(workspace.workspaceId);
    expect(f.sqlite.prepare("SELECT status FROM team_workspace_invitations").get()?.status).toBe("pending");
    await revokeTeamWorkspaceInvitation(f.env, workspace.workspaceId, owner, invitation.invitation.invitationId);
    expect(await validatePendingTeamInvitation(f.env, invitation.token, member)).toBeNull();
  });

  it("rejects verification after invitation revocation and never grants workspace membership during signup", async () => {
    const f = fixture(), setup = await invited(f);
    expect(f.sqlite.prepare("SELECT COUNT(*) AS c FROM team_workspace_memberships WHERE user_id=?").get(member)?.c).toBe(0);
    await revokeTeamWorkspaceInvitation(f.env, setup.workspace.workspaceId, owner, setup.invitation.invitation.invitationId);
    const response = (await native(new Request(setup.verificationUrl), f.env))!;
    expect(response.status).toBe(403);
    expect(f.sqlite.prepare(`SELECT emailVerified FROM "user" WHERE email=?`).get(member)?.emailVerified).toBe(0);
  });

  it("fails closed without a configured sender or mounted team member policy, without sending", async () => {
    const f = fixture(); await bootstrap(f);
    const disabled = await handleBetterAuth(request("/api/auth/invitation-policy"), f.env);
    expect(await disabled?.json()).toMatchObject({ enabled: false });
    const unavailableEnv = { ...f.env, SEND_EMAIL: undefined } as Env;
    const unavailable = await native(request("/api/auth/invitation-policy"), unavailableEnv);
    expect(await unavailable?.json()).toMatchObject({ enabled: false, reason: "Invitation enrollment is currently unavailable. Contact your workspace owner." });
    expect(f.send).not.toHaveBeenCalled();
    await expect(sendNativeEnrollmentVerification(f.env, { email: member, url: "https://evil.example/api/auth/verify-email?token=fixture" })).rejects.toThrow("destination");
    expect(f.send).not.toHaveBeenCalled();
  });

  it("does not promote an existing unmarked second account, even if its email is verified", async () => {
    const f = fixture(); const cookie = await bootstrap(f);
    expect(await resolveBetterAuthUserId(request("/api/whoami", "GET", undefined, { cookie }), f.env)).toBe(owner);
    f.sqlite.prepare(`INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES('unmarked','Unexpected',?,1,?,?)`).run(member, Date.now(), Date.now());
    await ensureBetterAuthSchema(f.env as Env & { AGENT_AUDIT: D1Database });
    expect(f.sqlite.prepare("SELECT COUNT(*) AS c FROM shiba_auth_account_policy WHERE account_id='unmarked'").get()?.c).toBe(0);
  });

  it("seeds the exact preexisting bootstrap once and refuses to guess in a multi-user legacy database", async () => {
    for (const count of [1, 2]) {
      const f = fixture();
      for (const sql of BETTER_AUTH_STATEMENTS) await f.env.AGENT_AUDIT.prepare(sql).run();
      for (let i = 0; i < count; i++) f.sqlite.prepare(`INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,0,?,?)`)
        .run(`legacy-${i}`, "Legacy", `legacy-${i}@example.test`, Date.now(), Date.now());
      await ensureBetterAuthSchema(f.env as Env & { AGENT_AUDIT: D1Database });
      expect(f.sqlite.prepare("SELECT account_id FROM shiba_auth_account_policy").all()).toEqual(count === 1 ? [{ account_id: "legacy-0" }] : []);
      f.sqlite.prepare(`INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES('later','Later','later@example.test',1,?,?)`).run(Date.now(), Date.now());
      await ensureBetterAuthSchema(f.env as Env & { AGENT_AUDIT: D1Database });
      expect(f.sqlite.prepare("SELECT COUNT(*) AS c FROM shiba_auth_account_policy").get()?.c).toBe(count === 1 ? 1 : 0);
    }
  });

  it("does not enroll or send mail for an expired invitation", async () => {
    const f = fixture(); await bootstrap(f);
    const workspace = await createTeamWorkspace(f.env, owner, { name: "Team" });
    const invitation = await createTeamWorkspaceInvitation(f.env, workspace.workspaceId, owner, { email: member, role: "member" }, 1);
    expect(await validatePendingTeamInvitation(f.env, invitation.token, member)).toBeNull();
    const response = await native(request("/api/auth/sign-up/email", "POST", { name: "Expired", email: member, password: "password-456" },
      { "x-shiba-workspace-invitation": invitation.token }), f.env);
    expect(response?.status).toBe(403); expect(f.send).not.toHaveBeenCalled();
    expect(f.sqlite.prepare(`SELECT COUNT(*) AS c FROM "user"`).get()?.c).toBe(1);
  });

  it("fails closed when verification transport fails after account creation", async () => {
    const f = fixture(); await bootstrap(f);
    const workspace = await createTeamWorkspace(f.env, owner, { name: "Team" });
    const invitation = await createTeamWorkspaceInvitation(f.env, workspace.workspaceId, owner, { email: member, role: "member" });
    f.send.mockRejectedValueOnce(new Error("fixture transport unavailable"));
    const response = await native(request("/api/auth/sign-up/email", "POST", { name: "Member", email: member, password: "password-456" },
      { "x-shiba-workspace-invitation": invitation.token }), f.env);
    expect(response?.status).toBe(503);
    expect(response?.headers.has("set-cookie")).toBe(false);
    const signedIn = (await native(request("/api/auth/sign-in/email", "POST", { email: member, password: "password-456" }), f.env))!;
    expect(signedIn.status).toBe(200);
    expect(await resolveBetterAuthUserId(request("/api/whoami", "GET", undefined, { cookie: cookies(signedIn) }), f.env)).toBeNull();
    expect(f.sqlite.prepare("SELECT COUNT(*) AS c FROM team_workspace_memberships WHERE user_id=?").get(member)?.c).toBe(0);
  });

  it("keeps deployment administration denied even after verified membership and workspace owner promotion", async () => {
    const f = fixture(), setup = await invited(f); await verify(f, setup.verificationUrl);
    await acceptTeamWorkspaceInvitation(f.env, member, setup.invitation.token);
    const req = (path: string, headers: Record<string, string> = {}) => request(path, "GET", undefined, { cookie: setup.cookie, ...headers });
    for (const path of ["/api/api-keys", "/api/agents", "/api/org/model-keys", "/api/org/sandbox", "/api/setup/fix", "/api/unknown-admin", "/oauth/authorize", "/mcp", "/api/approvals", "/api/spine", "/api/runs", "/api/sessions", "/api/employee-tools"]) {
      expect((await enforceTeamMemberApiPolicy(req(path), f.env))?.status).toBe(403);
    }
    expect(await enforceTeamMemberApiPolicy(req("/api/memory/facts"), f.env)).toBeNull();
    expect(await enforceTeamMemberApiPolicy(req("/api/providers"), f.env)).toBeNull();
    expect((await enforceTeamMemberApiPolicy(request("/api/providers/codex/connect", "POST", { mode: "api-key" }, { cookie: setup.cookie }), f.env))?.status).toBe(403);
    expect((await enforceTeamMemberApiPolicy(req("/api/custom-agents"), f.env))?.status).toBe(403);
    expect(await enforceTeamMemberApiPolicy(req("/api/custom-agents", { "X-Shiba-Workspace": setup.workspace.workspaceId }), f.env)).toBeNull();
    const workspaceId = setup.workspace.workspaceId, roomPath = `/api/collaboration/rooms/room_${"a".repeat(24)}`;
    expect(await enforceTeamMemberApiPolicy(req(`${roomPath}/realtime?workspaceId=${workspaceId}`, { Upgrade: "websocket" }), f.env)).toBeNull();
    expect(await enforceTeamMemberApiPolicy(req(`${roomPath}/handoffs/handoff1/artifacts/0?workspaceId=${workspaceId}`), f.env)).toBeNull();
    expect((await enforceTeamMemberApiPolicy(req(`/api/custom-agents?workspaceId=${workspaceId}`), f.env))?.status).toBe(403);
    expect((await enforceTeamMemberApiPolicy(req(`${roomPath}/realtime?workspaceId=${workspaceId}&workspaceId=${workspaceId}`, { Upgrade: "websocket" }), f.env))?.status).toBe(403);
    expect((await enforceTeamMemberApiPolicy(req(`${roomPath}/realtime?workspaceId=${workspaceId}`, { Upgrade: "websocket", "X-Shiba-Workspace": `ws_${"f".repeat(24)}` }), f.env))?.status).toBe(403);
    f.sqlite.prepare("UPDATE team_workspace_memberships SET role='owner' WHERE user_id=?").run(member);
    expect(await isTeamDeploymentOperator(req("/api/api-keys"), f.env)).toBe(false);
    f.sqlite.prepare("UPDATE team_workspace_memberships SET status='removed' WHERE user_id=?").run(member);
    expect((await enforceTeamMemberApiPolicy(req("/api/custom-agents", { "X-Shiba-Workspace": setup.workspace.workspaceId }), f.env))?.status).toBe(404);
  });
});
