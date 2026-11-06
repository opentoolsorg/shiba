import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleBetterAuth } from "../src/better-auth.js";
import { handleCollaborationWithRealtime } from "../src/collaboration-room-routes.js";
import { handleTeamWorkspaces } from "../src/team-workspaces-routes.js";
import type { Env } from "../src/env.js";

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const origin = "http://localhost:8787";

function request(path: string, cookie = "", body?: unknown, workspaceId?: string) {
  return new Request(`${origin}${path}`, { method: body === undefined ? "GET" : "POST", headers: { Origin: origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(workspaceId ? { "X-Shiba-Workspace": workspaceId } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

/** Real Better Auth cookies and DB checks, with the transport/runtime binding stubbed. */
describe("shared rooms with independent cookie-authenticated members", () => {
  it("keeps two signed sessions distinct, shares persisted context, and revokes the member without trusting identity headers", async () => {
    const sqlite = new DatabaseSync(":memory:");
    databases.push(sqlite);
    const prepare = (sql: string, values: unknown[] = []) => ({
      bind: (...args: unknown[]) => prepare(sql, args.map((value) => value instanceof Date ? value.getTime() : typeof value === "boolean" ? Number(value) : value ?? null)),
      execute() {
        const results = sqlite.prepare(sql).all(...values as never[]);
        const meta = sqlite.prepare("SELECT changes() AS changes, last_insert_rowid() AS last_row_id").get();
        return { success: true, results, meta };
      },
      async run() { return prepare(sql, values).execute(); },
      async all() { return prepare(sql, values).execute(); },
      async first() { return sqlite.prepare(sql).get(...values as never[]) ?? null; },
    });
    const db = {
      prepare,
      async batch(statements: ReturnType<typeof prepare>[]) {
        sqlite.exec("BEGIN IMMEDIATE");
        try { const results = statements.map((statement) => statement.execute()); sqlite.exec("COMMIT"); return results; }
        catch (error) { sqlite.exec("ROLLBACK"); throw error; }
      },
      exec(sql: string) { sqlite.exec(sql); return { count: 0, duration: 0 }; },
    } as unknown as D1Database;
    const routed: Request[] = [];
    const env = {
      AGENT_AUDIT: db,
      BETTER_AUTH_SECRET: "isolated-test-cookie-secret-at-least-32-characters",
      BETTER_AUTH_URL: origin,
      ConversationRoom: { getByName: () => ({ fetch: async (value: Request) => { routed.push(value); return new Response(null); }, notifyCollaborationChange: vi.fn(async () => {}) }) },
    } as unknown as Env;
    const signUp = await handleBetterAuth(request("/api/auth/sign-up/email", "", { name: "Owner", email: "owner@example.test", password: "isolated-test-password" }), env);
    expect(signUp?.status).toBe(200);
    const ownerCookie = signUp!.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
    const workspaceResponse = await handleTeamWorkspaces(request("/api/workspaces", ownerCookie, { name: "Cookie-authenticated team" }), env);
    expect(workspaceResponse?.status).toBe(201);
    const { workspace } = await workspaceResponse!.json() as { workspace: { workspaceId: string } };
    const workspaceId = workspace.workspaceId;
    const invitationResponse = await handleTeamWorkspaces(request(`/api/workspaces/${workspaceId}/invitations`, ownerCookie, { email: "teammate@example.test", role: "member" }), env);
    expect(invitationResponse?.status).toBe(201);
    const { invitation, token } = await invitationResponse!.json() as { invitation: { invitationId: string }; token: string };
    // Local-only fixture: emulate completed independent mailbox verification
    // and its exact immutable invitation provenance, without enabling native
    // signup or sending email. All login and workspace/room access still use
    // the actual cookie-authenticated product handlers below.
    const owner = sqlite.prepare('SELECT * FROM "user"').get()!;
    const account = sqlite.prepare('SELECT * FROM "account"').get()!;
    sqlite.prepare('INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)').run("fixture-member", "Teammate", "teammate@example.test", 1, owner.createdAt!, owner.updatedAt!);
    sqlite.prepare("INSERT INTO shiba_auth_account_policy(account_id,email,kind,invitation_id,workspace_id) VALUES(?,?,'invited',?,?)")
      .run("fixture-member", "teammate@example.test", invitation.invitationId, workspaceId);
    sqlite.prepare('INSERT INTO "account" (id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)').run("fixture-account", "fixture-member", "credential", "fixture-member", account.password!, account.createdAt!, account.updatedAt!);
    const signIn = await handleBetterAuth(request("/api/auth/sign-in/email", "", { email: "teammate@example.test", password: "isolated-test-password" }), env);
    expect(signIn?.status).toBe(200);
    const memberCookie = signIn!.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
    expect(memberCookie).not.toBe(ownerCookie);
    const accepted = await handleTeamWorkspaces(request("/api/workspaces/invitations/accept", memberCookie, { token }), env);
    expect(accepted?.status).toBe(200);
    const created = await handleCollaborationWithRealtime(request("/api/collaboration/rooms", ownerCookie, { title: "Cookie-authenticated team" }, workspaceId), env);
    expect(created?.status).toBe(201);
    const { room } = await created!.json() as { room: { roomId: string } };
    const path = `/api/collaboration/rooms/${room.roomId}`;
    expect((await handleCollaborationWithRealtime(request(path, memberCookie, undefined, workspaceId), env))?.status).toBe(404);
    expect((await handleCollaborationWithRealtime(request(`${path}/members`, ownerCookie, { userId: "teammate@example.test" }, workspaceId), env))?.status).toBe(201);
    expect((await handleCollaborationWithRealtime(request(`${path}/messages`, memberCookie, { body: "Shared only after an explicit room grant" }, workspaceId), env))?.status).toBe(201);
    const shared = await handleCollaborationWithRealtime(request(path, ownerCookie, undefined, workspaceId), env);
    expect((await shared!.json() as { messages: Array<{ senderUserId: string }> }).messages).toEqual([expect.objectContaining({ senderUserId: "teammate@example.test" })]);
    const viewer = crypto.randomUUID();
    for (const cookie of [ownerCookie, memberCookie]) {
      const socketRequest = new Request(`${origin}${path}/realtime?viewer=${viewer}&workspaceId=${workspaceId}`, { headers: { Origin: origin, Upgrade: "websocket", Cookie: cookie, "CF-Access-Authenticated-User-Email": "forged-owner@example.test" } });
      expect((await handleCollaborationWithRealtime(socketRequest, env))?.status).toBe(200);
    }
    expect(routed.map((value) => value.headers.get("x-shiba-room-actor"))).toEqual(["owner@example.test", "teammate@example.test"]);
    expect(routed[0]!.headers.get("x-shiba-room-viewer")).not.toBe(routed[1]!.headers.get("x-shiba-room-viewer"));
    const removed = await handleCollaborationWithRealtime(new Request(`${origin}${path}/members/${encodeURIComponent("human:teammate@example.test")}`, { method: "DELETE", headers: { Origin: origin, Cookie: ownerCookie, "X-Shiba-Workspace": workspaceId } }), env);
    expect(removed?.status).toBe(200);
    expect((await handleCollaborationWithRealtime(request(path, memberCookie, undefined, workspaceId), env))?.status).toBe(404);
    const spoofed = new Request(`${origin}${path}`, { headers: { "CF-Access-Authenticated-User-Email": "owner@example.test", "X-Shiba-Workspace": workspaceId } });
    expect((await handleCollaborationWithRealtime(spoofed, env))?.status).toBe(401);
    expect((await handleCollaborationWithRealtime(request(path, ownerCookie, undefined, workspaceId), env))?.status).toBe(200);
  }, 15_000);
});
