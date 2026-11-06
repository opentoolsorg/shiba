import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onboardingTaskText, teamOnboardingTaskSchema } from "@shiba/shared";
import type { Env } from "../src/env.js";
import { handleOnboardingProgress } from "../src/onboarding-progress.js";
import { handleTeamOnboardingTask } from "../src/team-onboarding-task.js";
import { enforceTeamMemberApiPolicy } from "../src/team-member-auth.js";
import { createCustomAgent } from "../src/custom-agents-store.js";
import { acceptTeamWorkspaceInvitation, createTeamWorkspace, createTeamWorkspaceInvitation } from "../src/team-workspaces-store.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const actor = vi.hoisted(() => ({ email: "owner@example.test", native: true, expiresAt: 0, ids: {} as Record<string, string> }));
vi.mock("@shiba/auth/better-auth", async (original) => ({ ...await original<typeof import("@shiba/auth/better-auth")>(), resolveBetterAuthSessionAccount: async () => actor.native ? {
  policy: { accountId: actor.ids[actor.email], email: actor.email, kind: actor.email === "owner@example.test" ? "bootstrap" : "invited" }, emailVerified: true,
  sessionId: `session:${actor.email}`, sessionExpiresAt: actor.expiresAt,
} : null }));
vi.mock("../src/request-auth.js", async (original) => ({ ...await original<typeof import("../src/request-auth.js")>(), isAuthorizedRequest: async () => true, resolveUserId: async () => actor.email }));
beforeEach(() => { actor.email = "owner@example.test"; actor.native = true; actor.ids = {}; actor.expiresAt = Date.now() + 60_000; });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

async function fixture(withEmployee = false) {
  const f = customAgentD1();
  f.sqlite.exec('CREATE TABLE "user"(id TEXT PRIMARY KEY,email TEXT,emailVerified INTEGER); CREATE TABLE shiba_auth_account_policy(account_id TEXT PRIMARY KEY,email TEXT,kind TEXT); CREATE TABLE "session"(id TEXT PRIMARY KEY,userId TEXT,expiresAt INTEGER)');
  for (const email of [actor.email, "member@example.test"]) {
    actor.ids[email] = crypto.randomUUID();
    f.sqlite.prepare('INSERT INTO "user" VALUES(?,?,1)').run(actor.ids[email], email);
    f.sqlite.prepare("INSERT INTO shiba_auth_account_policy VALUES(?,?,?)").run(actor.ids[email], email, email === actor.email ? "bootstrap" : "invited");
    f.sqlite.prepare('INSERT INTO "session" VALUES(?,?,?)').run(`session:${email}`, actor.ids[email], actor.expiresAt);
  }
  const env = { AGENT_AUDIT: f.database, BETTER_AUTH_SECRET: "s".repeat(32) } as unknown as Env;
  const team = await createTeamWorkspace(env, actor.email, { name: "Team" });
  const other = await createTeamWorkspace(env, actor.email, { name: "Other team" });
  const invitation = await createTeamWorkspaceInvitation(env, team.workspaceId, actor.email, { email: "member@example.test", role: "member" });
  await acceptTeamWorkspaceInvitation(env, "member@example.test", invitation.token);
  const employee = withEmployee ? await createCustomAgent(env, `team:${team.workspaceId}`, "team-writer", { name: "Team writer", instructions: "Write a supplied-context draft", harness: "opencode" }) : null;
  const request = (path: string, method = "GET", body?: unknown, workspace = team.workspaceId, signal?: AbortSignal) => new Request(`https://shiba.test${path}`, { method, headers: {
    "X-Shiba-Workspace": workspace, Origin: "https://shiba.test", "Content-Type": "application/json", Cookie: "native-fixture-session",
  }, ...(body ? { body: JSON.stringify(body) } : {}), ...(signal ? { signal } : {}) });
  const answers = { goal: "Write a team brief", audience: "The review team", acceptance: "Cite supplied facts and flag missing sources", contextAnswer: "Supplied fact <untrusted>", ...(employee ? { employeeId: employee.id, employeeVersion: employee.version } : {}) };
  const setup = async (body?: unknown) => handleOnboardingProgress(request("/api/onboarding/progress", body ? "POST" : "GET", body), env, { resolveIdentity: async () => ({ userId: actor.ids[actor.email]!, ownerEmail: actor.email }) });
  await setup();
  const saved = await (await setup({ action: "save-draft", expectedRevision: 0, draftTask: answers }))!.json() as { draftTaskId: string; draftTask: { version: number }; revision: number };
  const parameters = new URLSearchParams({ draftTaskId: saved.draftTaskId, draftTaskVersion: String(saved.draftTask.version), expectedRevision: String(saved.revision) });
  const path = `/api/onboarding/progress/team-task?${parameters}`;
  const call = async (req = request(path)) => { const response = (await handleTeamOnboardingTask(req, env))!; return { response, body: await response.json() as Record<string, unknown> }; };
  for (const name of ["Memory", "CodingOrchestrator", "Sandbox", "AI", "OPEN_CONNECTOR", "SLACK_BOT_TOKEN", "GITHUB_TOKEN", "AI_GATEWAY_TOKEN"]) Object.defineProperty(env, name, { get() { throw new Error(`Task snapshot must not access ${name}`); } });
  return { ...f, env, employee, answers, saved, path, parameters, call, request, setup, workspaceId: team.workspaceId, otherId: other.workspaceId };
}

function atProof(f: Awaited<ReturnType<typeof fixture>>, action: () => void, after = false) {
  const original = f.env.AGENT_AUDIT;
  type Statement = D1PreparedStatement & { execute(): unknown };
  f.env.AGENT_AUDIT = { ...original, prepare(sql: string) {
    const statement = original.prepare(sql);
    const wrap = (s: D1PreparedStatement): D1PreparedStatement => ({ ...s, bind: (...values: unknown[]) => wrap(s.bind(...values)), first: async () => {
      if (!after) action(); const result = await s.first(); if (after) action(); return result;
    }, all: () => s.all(), run: () => s.run(), execute: () => (s as Statement).execute() } as Statement);
    return sql.startsWith("SELECT s.expiresAt AS session_expires_at") ? wrap(statement) : statement;
  } } as D1Database;
}

describe("owned saved team task transfer", () => {
  it("returns exact saved bytes and provenance without publishing, starting work or reading private sources", async () => {
    const f = await fixture(true), before = f.sqlite.prepare("SELECT * FROM user_onboarding_progress").all();
    const { response, body } = await f.call(); expect(response.status).toBe(200);
    expect(teamOnboardingTaskSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ workspaceId: f.workspaceId, actorId: actor.email, accountId: actor.ids[actor.email], draftTaskId: f.saved.draftTaskId, draftTaskVersion: 1,
      progressRevision: f.saved.revision, text: onboardingTaskText(f.answers), employee: { id: f.employee!.id, version: 1 } });
    expect(body.expiresAt).toBeLessThanOrEqual(actor.expiresAt);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(f.sqlite.prepare("SELECT * FROM user_onboarding_progress").all()).toEqual(before);
    expect(body).not.toHaveProperty("sourceRefs"); expect(body).not.toHaveProperty("preparedAt");
  });
  it("permits an invited member's own saved draft but never another account's or workspace's record", async () => {
    const f = await fixture(); actor.email = "member@example.test";
    expect((await enforceTeamMemberApiPolicy(f.request(f.path), f.env))).toBeNull();
    expect((await f.call()).response.status).toBe(409);
    actor.email = "owner@example.test";
    expect((await f.call(f.request(f.path, "GET", undefined, f.otherId))).response.status).toBe(409);
  });
  it("loads an invited member's independently saved task without adopting the owner's draft", async () => {
    const f = await fixture(); actor.email = "member@example.test";
    await f.setup();
    const saved = await (await f.setup({ action: "save-draft", expectedRevision: 0, draftTask: { ...f.answers, goal: "Member-owned task" } }))!.json() as { draftTaskId: string; revision: number; draftTask: { version: number } };
    const query = new URLSearchParams({ draftTaskId: saved.draftTaskId, draftTaskVersion: String(saved.draftTask.version), expectedRevision: String(saved.revision) });
    const result = await f.call(f.request(`/api/onboarding/progress/team-task?${query}`));
    expect(result.response.status).toBe(200); expect(result.body).toMatchObject({ actorId: actor.email, accountId: actor.ids[actor.email], draftTaskId: saved.draftTaskId });
    expect(result.body.text).toContain("Member-owned task"); expect(result.body.text).not.toContain(f.answers.goal);
  });
  it.each(["draftTaskVersion", "expectedRevision"])("rejects a stale %s without returning content", async (field) => {
    const f = await fixture(); f.parameters.set(field, "999");
    const result = await f.call(f.request(`/api/onboarding/progress/team-task?${f.parameters}`));
    expect(result.response.status).toBe(409); expect(JSON.stringify(result.body)).not.toContain(f.answers.goal);
  });
  it("rejects bearer, missing-cookie, automation identity and ambiguous selectors", async () => {
    const f = await fixture();
    const bearer = f.request(f.path); bearer.headers.set("Authorization", "Bearer fixture"); expect((await f.call(bearer)).response.status).toBe(403);
    const anonymous = f.request(f.path); anonymous.headers.delete("Cookie"); expect((await f.call(anonymous)).response.status).toBe(403);
    expect((await f.call(f.request(`${f.path}&expectedRevision=1`))).response.status).toBe(400);
    expect((await f.call(f.request(`${f.path}&workspaceId=${f.workspaceId}`))).response.status).toBe(400);
    actor.native = false; expect((await f.call()).response.status).toBe(403);
  });
  it.each(["member", "session", "bytes", "employee", "account"])("rechecks %s in the final SQLite proof", async (kind) => {
    const f = await fixture(true);
    atProof(f, () => {
      if (kind === "member") f.sqlite.prepare("UPDATE team_workspace_memberships SET status='removed',version=version+1 WHERE workspace_id=? AND user_id=?").run(f.workspaceId, actor.email);
      if (kind === "session") f.sqlite.prepare('DELETE FROM "session"').run();
      if (kind === "bytes") f.sqlite.prepare("UPDATE user_onboarding_progress SET draft_task_json=replace(draft_task_json,'Write a team brief','Changed task bytes')").run();
      if (kind === "employee") f.sqlite.prepare("UPDATE org_custom_agents SET version=version+1").run();
      if (kind === "account") f.sqlite.prepare('UPDATE "user" SET emailVerified=0').run();
    });
    const result = await f.call(); expect(result.response.status).toBe(409); expect(JSON.stringify(result.body)).not.toContain(f.answers.goal);
  });
  it("checks the actual database session lease synchronously after a held proof", async () => {
    const f = await fixture(); const now = Date.now(); vi.useFakeTimers(); vi.setSystemTime(now);
    f.sqlite.prepare('UPDATE "session" SET expiresAt=?').run(now + 1000);
    atProof(f, () => vi.setSystemTime(now + 2000), true);
    const result = await f.call(); expect(result.response.status).toBe(409); expect(JSON.stringify(result.body)).not.toContain(f.answers.goal);
  });
  it.each(["private-source", "oversize"])("refuses %s instead of inheriting or truncating it", async (kind) => {
    const f = await fixture();
    const row = f.sqlite.prepare("SELECT draft_task_json FROM user_onboarding_progress").get() as { draft_task_json: string };
    const draft = JSON.parse(row.draft_task_json);
    if (kind === "private-source") draft.sourceIds = ["private-memory-source"];
    else draft.goal = "a".repeat(3999);
    f.sqlite.prepare("UPDATE user_onboarding_progress SET draft_task_json=?").run(JSON.stringify(draft));
    const result = await f.call(); expect(result.response.status).toBe(kind === "oversize" ? 422 : 409); expect(result.body).not.toHaveProperty("text");
  });
});
