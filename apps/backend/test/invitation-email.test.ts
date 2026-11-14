import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BETTER_AUTH_STATEMENTS, ensureBetterAuthSchema } from "../src/better-auth.js";
import { sendWorkspaceInvitationEmail } from "../src/native-enrollment-email.js";
import { createTeamWorkspace, createTeamWorkspaceInvitation } from "../src/team-workspaces-store.js";
import type { Env } from "../src/env.js";

const outboxMigration = readFileSync(new URL("../migrations/0040_email_outbox.sql", import.meta.url), "utf8");
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.restoreAllMocks(); });

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  databases.push(sqlite);
  sqlite.exec(outboxMigration);
  const value = (item: unknown): never => (typeof item === "boolean" ? Number(item) : item ?? null) as never;
  const statement = (sql: string, values: unknown[] = []) => ({
    bind: (...args: unknown[]) => statement(sql, args),
    async all() { return { results: sqlite.prepare(sql).all(...values.map(value)), meta: { changes: Number((sqlite.prepare("SELECT changes() AS c").get() as { c: number }).c) } }; },
    async run() { return this.all(); },
    async first() { return sqlite.prepare(sql).get(...values.map(value)) ?? null; },
  });
  const database = { prepare: (sql: string) => statement(sql), exec: (sql: string) => sqlite.exec(sql),
    batch: async (items: ReturnType<typeof statement>[]) => { sqlite.exec("BEGIN IMMEDIATE"); try { const results = []; for (const item of items) results.push(await item.all()); sqlite.exec("COMMIT"); return results; } catch (error) { sqlite.exec("ROLLBACK"); throw error; } } } as unknown as D1Database;
  const send = vi.fn(async () => ({}));
  const env = { AGENT_AUDIT: database, BETTER_AUTH_URL: "https://team.example.test", BETTER_AUTH_VERIFICATION_FROM: "auth@example.test", SEND_EMAIL: { send } } as unknown as Env;
  return { sqlite, env, send };
}

describe("workspace invitation email", () => {
  it("enqueues an outbox row when inviting a member", async () => {
    const f = fixture();
    await ensureBetterAuthSchema(f.env);
    for (const statement of BETTER_AUTH_STATEMENTS) f.sqlite.exec(statement);
    const owner = "owner@example.test";
  f.sqlite.prepare(`INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES('owner','Owner',?,1,?,?)`).run(owner, Date.now(), Date.now());
    const workspace = await createTeamWorkspace(f.env, owner, { name: "Core" });
    const invite = await createTeamWorkspaceInvitation(f.env, workspace.workspaceId, owner, { email: "member@example.test", role: "member" });
    await sendWorkspaceInvitationEmail(f.env, { email: invite.invitation.email, token: invite.token, workspaceName: workspace.name });
    expect(f.send).toHaveBeenCalledTimes(1);
    const row = f.sqlite.prepare("SELECT template_kind, to_address FROM email_outbox LIMIT 1").get() as { template_kind: string; to_address: string };
    expect(row.template_kind).toBe("workspace_invitation");
    expect(row.to_address).toBe("member@example.test");
  });
});