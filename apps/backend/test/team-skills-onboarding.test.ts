import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { handleV1 } from "../src/v1-routes.js";
import { handleSkillLibrary } from "../src/skill-library-routes.js";
import { handleSkills } from "../src/skills-routes.js";
import { handleFounderSkills } from "../src/founder-skills-routes.js";
import { handleSpaces } from "../src/spaces-routes.js";
import { createSkill, reviewSkill, activateSkill } from "../src/skills-store.js";
import { installLibrarySkill } from "../src/skill-library/install.js";
import { handleOnboardingProgress } from "../src/onboarding-progress.js";
import { createCustomAgent, updateCustomAgent } from "../src/custom-agents-store.js";
import { archiveExtensionSkill, createExtensionSkill } from "../src/extension-skills-store.js";
import { acceptTeamWorkspaceInvitation, createTeamWorkspace, createTeamWorkspaceInvitation } from "../src/team-workspaces-store.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const actor = vi.hoisted(() => ({ email: "owner@example.test" }));
vi.mock("../src/request-auth.js", async (original) => ({ ...await original<typeof import("../src/request-auth.js")>(),
  isAuthorizedRequest: async () => true, resolveUserId: async () => actor.email,
}));
beforeEach(() => { actor.email = "owner@example.test"; });

async function fixture() {
  const db = customAgentD1();
  const env = { AGENT_AUDIT: db.database, BETTER_AUTH_SECRET: "s".repeat(32) } as unknown as Env;
  const workspace = await createTeamWorkspace(env, actor.email, { name: "Team A" });
  const other = await createTeamWorkspace(env, actor.email, { name: "Team B" });
  for (const [email, role] of [["member@example.test", "member"], ["admin@example.test", "admin"]] as const) {
    const invite = await createTeamWorkspaceInvitation(env, workspace.workspaceId, actor.email, { email, role });
    await acceptTeamWorkspaceInvitation(env, email, invite.token);
  }
  const request = (path: string, method = "GET", body?: unknown, workspaceId = workspace.workspaceId) => new Request(`https://shiba.test${path}`, {
    method, headers: { Origin: "https://shiba.test", "Content-Type": "application/json", "X-Shiba-Workspace": workspaceId },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const evidence = vi.fn(async () => { throw new Error("Private stores must not be consulted."); });
  const onboarding = (method = "GET", body?: unknown, workspaceId?: string) => handleOnboardingProgress(request("/api/onboarding/progress", method, body, workspaceId), env, {
    resolveIdentity: async () => ({ userId: `auth:${actor.email}`, ownerEmail: actor.email }),
    readProviders: evidence, readSuccessfulRun: evidence, readSourceRefs: evidence,
  });
  return { ...db, env, request, onboarding, evidence, workspaceId: workspace.workspaceId, otherId: other.workspaceId, grant: { workspaceId: workspace.workspaceId, userId: actor.email, role: "owner" as const, version: workspace.membership.version } };
}

function interceptStorage(f: Awaited<ReturnType<typeof fixture>>, match: (sql: string) => boolean, action: () => void) {
  type Statement = D1PreparedStatement & { execute(): unknown };
  let intercepted = false;
  const trigger = () => { if (!intercepted) { intercepted = true; action(); } };
  const wrap = (value: D1PreparedStatement): D1PreparedStatement => {
    const statement = value as Statement;
    return { ...statement, bind: (...values: unknown[]) => wrap(statement.bind(...values)),
      all: async () => { trigger(); return statement.all(); }, first: async () => { trigger(); return statement.first(); },
      run: async () => { trigger(); return statement.run(); }, execute: () => { trigger(); return statement.execute(); },
    } as Statement;
  };
  f.env.AGENT_AUDIT = { ...f.database, prepare(sql: string) { const statement = f.database.prepare(sql); return match(sql) ? wrap(statement) : statement; } } as D1Database;
  return () => intercepted;
}
function removeActor(f: Awaited<ReturnType<typeof fixture>>) {
  f.sqlite.prepare("UPDATE team_workspace_memberships SET status='removed',version=version+1 WHERE workspace_id=? AND user_id=?").run(f.workspaceId, actor.email);
}
function managedSnapshot(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    skills: f.sqlite.prepare("SELECT * FROM skills ORDER BY id").all(),
    versions: f.sqlite.prepare("SELECT * FROM skill_versions ORDER BY skill_id,version").all(),
    installs: f.sqlite.prepare("SELECT * FROM skill_installs ORDER BY library_slug,installed_by").all(),
  };
}

describe("managed team skill grant races", () => {
  it.each(["list", "record", "versions", "library", "founder"])("rechecks the %s response after awaited reads", async (kind) => {
    const f = await fixture(), orgId = `team:${f.workspaceId}`;
    const skill = await createSkill(f.env, orgId, actor.email, { name: "Shared fixture", instructions: "Current team instructions" }, Date.now(), { teamGrant: f.grant });
    await reviewSkill(f.env, orgId, actor.email, skill.id, 1, skill.content.instructions, Date.now(), { teamGrant: f.grant });
    await activateSkill(f.env, orgId, actor.email, skill.id, 1, skill.content.instructions, Date.now(), { teamGrant: f.grant });
    await installLibrarySkill(f.env, orgId, actor.email, "pr-review-checklist", { teamGrant: f.grant });
    const intercepted = interceptStorage(f, (sql) => /^SELECT /.test(sql) && /FROM (skills|skill_versions|skill_installs)\b/.test(sql), () => removeActor(f));
    const response = kind === "library" ? await handleSkillLibrary(f.request("/api/skills/library"), f.env)
      : kind === "founder" ? await handleFounderSkills(f.request("/api/founder-skills"), f.env)
      : await handleSkills(f.request(kind === "list" ? "/api/skills" : `/api/skills/${skill.id}${kind === "versions" ? "/versions" : ""}`), f.env);
    expect(intercepted()).toBe(true); expect(response?.status).toBe(404);
    expect(await response!.text()).not.toContain("Current team instructions");
  });

  it.each(["create", "edit", "review", "activate", "disable", "install", "remove", "founder"])("refuses %s when removal occurs at the exact database write", async (kind) => {
    const f = await fixture(), orgId = `team:${f.workspaceId}`;
    const skill = await createSkill(f.env, orgId, actor.email, { name: "Owned draft", instructions: "Reviewed body" }, Date.now(), { teamGrant: f.grant });
    if (kind === "activate") await reviewSkill(f.env, orgId, actor.email, skill.id, 1, skill.content.instructions, Date.now(), { teamGrant: f.grant });
    if (kind === "remove") await installLibrarySkill(f.env, orgId, actor.email, "pr-review-checklist", { teamGrant: f.grant });
    const before = managedSnapshot(f);
    const intercepted = interceptStorage(f, (sql) => /^(INSERT INTO|UPDATE|DELETE FROM) (skills|skill_versions|skill_installs)\b/.test(sql), () => removeActor(f));
    const response = kind === "install" || kind === "remove"
      ? await handleSkillLibrary(f.request("/api/skills/library/pr-review-checklist/install", kind === "install" ? "POST" : "DELETE"), f.env)
      : kind === "founder" ? await handleFounderSkills(f.request("/api/founder-skills/founder-weekly-ads-report/install", "POST"), f.env)
      : await handleSkills(f.request(kind === "create" ? "/api/skills" : `/api/skills/${skill.id}${["review", "activate", "disable"].includes(kind) ? `/${kind}` : ""}`,
        kind === "edit" ? "PATCH" : "POST", kind === "create" || kind === "edit" ? { name: "Changed", instructions: "New body", expectedVersion: 1 } : kind === "review" || kind === "activate" ? { version: 1, reviewedInstructions: "Reviewed body" } : undefined), f.env);
    expect(intercepted()).toBe(true); expect(response?.status).toBe(404);
    expect(managedSnapshot(f)).toEqual(before);
  });

  it("fails closed for a team store mutation without a grant and keeps team Spaces explicitly unavailable", async () => {
    const f = await fixture();
    await expect(createSkill(f.env, `team:${f.workspaceId}`, actor.email, { name: "Missing grant", instructions: "Body" })).rejects.toThrow("workspace_authority_changed");
    await expect(createExtensionSkill(f.env, `team:${f.workspaceId}`, actor.email, { name: "Missing grant", description: "Body", instructions: "Body" })).rejects.toThrow("workspace_authority_changed");
    f.env.Spaces = {} as Env["Spaces"];
    expect((await handleSpaces(f.request("/api/spaces"), f.env))?.status).toBe(501);
  });
});

describe("team skills use verified workspace scope", () => {
  const base = "/api/v1/extensions/skills";
  it.each(["list", "directory", "record", "instructions"])("drops the %s response when membership is removed during its awaited read", async (kind) => {
    const f = await fixture();
    const id = await createExtensionSkill(f.env, `team:${f.workspaceId}`, actor.email, { name: "Shared", description: "Shared summary", instructions: "Private to current team members", enabled: true, scope: "workspace", workspaceId: `team:${f.workspaceId}` }, Date.now(), { teamGrant: f.grant });
    actor.email = "member@example.test";
    let removed = false;
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement => ({
      ...statement,
      bind: (...values: unknown[]) => wrap(statement.bind(...values)),
      all: async (...args: Parameters<D1PreparedStatement["all"]>) => {
        const result = await statement.all(...args);
        remove(); return result;
      },
      first: async (...args: Parameters<D1PreparedStatement["first"]>) => {
        const result = await statement.first(...args);
        remove(); return result;
      },
    }) as D1PreparedStatement;
    const remove = () => {
      removed = true;
      f.sqlite.prepare("UPDATE team_workspace_memberships SET status='removed',version=version+1 WHERE workspace_id=? AND user_id=?").run(f.workspaceId, actor.email);
    };
    f.env.AGENT_AUDIT = { ...f.database, prepare(sql: string) {
      const statement = f.database.prepare(sql);
      return sql.startsWith("SELECT id, org_id, owner_id") && sql.includes("org_extension_skills") ? wrap(statement) : statement;
    } } as D1Database;
    const path = kind === "list" ? `${base}?view=workspace` : kind === "directory" ? `${base}/directory` : `${base}/${id}${kind === "instructions" ? "/instructions" : ""}`;
    const response = await handleV1(f.request(path), f.env);
    expect(removed).toBe(true); expect(response?.status).toBe(404);
    expect(await response!.text()).not.toContain("Private to current team members");
  });

  it.each(["create", "edit", "delete", "scope", "archive", "restore"])("refuses %s atomically if the manager is removed immediately before the database write", async (kind) => {
    const f = await fixture();
    const id = await createExtensionSkill(f.env, `team:${f.workspaceId}`, actor.email, { name: "Shared", description: "Summary", instructions: "Reviewed instructions", enabled: false, scope: kind === "scope" ? "personal" : "workspace", workspaceId: `team:${f.workspaceId}` }, Date.now(), { teamGrant: f.grant });
    if (kind === "restore") await archiveExtensionSkill(f.env, `team:${f.workspaceId}`, actor.email, id, Date.now(), { teamGrant: f.grant });
    const before = f.sqlite.prepare("SELECT * FROM org_extension_skills ORDER BY id").all();
    let removed = false;
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement => ({
      ...statement, bind: (...values: unknown[]) => wrap(statement.bind(...values)),
      run: async (...args: Parameters<D1PreparedStatement["run"]>) => {
        removed = true;
        f.sqlite.prepare("UPDATE team_workspace_memberships SET status='removed',version=version+1 WHERE workspace_id=? AND user_id=?").run(f.workspaceId, actor.email);
        return statement.run(...args);
      },
    }) as D1PreparedStatement;
    f.env.AGENT_AUDIT = { ...f.database, prepare(sql: string) {
      const statement = f.database.prepare(sql);
      return /^(INSERT INTO|UPDATE|DELETE FROM) org_extension_skills\b/.test(sql) ? wrap(statement) : statement;
    } } as D1Database;
    const method = kind === "create" ? "POST" : kind === "edit" ? "PATCH" : kind === "delete" ? "DELETE" : "POST";
    const path = kind === "create" ? base : `${base}/${id}${["scope", "archive", "restore"].includes(kind) ? `/${kind}` : ""}`;
    const body = kind === "create" ? { name: "Unauthorized new skill", description: "Summary", instructions: "Body" } : kind === "edit" ? { instructions: "Unauthorized overwrite", expectedVersion: 1 } : kind === "scope" ? { to: "workspace" } : undefined;
    const response = await handleV1(f.request(path, method, body), f.env);
    expect(removed).toBe(true); expect(response?.status).toBe(404);
    expect(f.sqlite.prepare("SELECT * FROM org_extension_skills ORDER BY id").all()).toEqual(before);
  });

  it.each(["demotion", "replacement"])("refuses a formerly authorized admin after grant %s during a write", async (change) => {
    const f = await fixture();
    const id = await createExtensionSkill(f.env, `team:${f.workspaceId}`, actor.email, { name: "Shared", description: "Summary", instructions: "Original", enabled: false, scope: "workspace", workspaceId: `team:${f.workspaceId}` }, Date.now(), { teamGrant: f.grant });
    actor.email = "admin@example.test";
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement => ({ ...statement, bind: (...values: unknown[]) => wrap(statement.bind(...values)), run: async () => {
      f.sqlite.prepare("UPDATE team_workspace_memberships SET role=?,version=version+1 WHERE workspace_id=? AND user_id=?").run(change === "demotion" ? "member" : "admin", f.workspaceId, actor.email);
      return statement.run();
    } }) as D1PreparedStatement;
    f.env.AGENT_AUDIT = { ...f.database, prepare(sql: string) { const statement = f.database.prepare(sql); return sql.startsWith("UPDATE org_extension_skills SET") ? wrap(statement) : statement; } } as D1Database;
    const response = await handleV1(f.request(`${base}/${id}`, "PATCH", { instructions: "Unauthorized after demotion", expectedVersion: 1 }), f.env);
    expect(response?.status).toBe(403);
    expect(f.sqlite.prepare("SELECT instructions FROM org_extension_skills WHERE id=?").get(id)).toMatchObject({ instructions: "Original" });
  });
  it("isolates personal instructions, creates disabled team instructions and rechecks roles and revocation", async () => {
    const f = await fixture();
    await createExtensionSkill(f.env, "self-hosted", actor.email, { name: "Private owner", description: "Private", instructions: "Never share this body", scope: "workspace", workspaceId: "self-hosted" });
    expect(await (await handleV1(f.request(base), f.env))?.json()).toEqual([]);
    expect((await handleV1(f.request(base, "POST", { name: "Bad", description: "Bad", instructions: "Bad", enabled: true }), f.env))?.status).toBe(400);
    const created = await handleV1(f.request(base, "POST", { name: "Team brief", description: "Shared facts", instructions: "Review supplied facts.", scope: "workspace" }), f.env);
    expect(created?.status).toBe(201);
    const { id } = await created!.json() as { id: string };
    expect(await (await handleV1(f.request(`${base}/${id}`), f.env))?.json()).toMatchObject({ enabled: false, version: 1, workspaceId: `team:${f.workspaceId}` });
    expect((await handleV1(f.request(`${base}/${id}`, "PATCH", { enabled: true }), f.env))?.status).toBe(400);
    expect((await handleV1(f.request(`${base}/${id}`, "PATCH", { enabled: true, expectedVersion: 1 }), f.env))?.status).toBe(200);
    actor.email = "member@example.test";
    expect(await (await handleV1(f.request(base), f.env))?.json()).toMatchObject([{ name: "Team brief", version: 2, permissions: { canEdit: false, canArchive: false } }]);
    expect(await (await handleV1(f.request(`${base}/${id}/instructions`), f.env))?.json()).toMatchObject({ instructions: "Review supplied facts.", version: 2 });
    expect((await handleV1(f.request(`${base}/${id}`, "PATCH", { name: "Takeover", expectedVersion: 2 }), f.env))?.status).toBe(403);
    actor.email = "admin@example.test";
    expect((await handleV1(f.request(`${base}/${id}`, "PATCH", { instructions: "Reviewed new facts.", expectedVersion: 2 }), f.env))?.status).toBe(200);
    expect((await handleV1(f.request(`${base}/${id}`, "PATCH", { instructions: "Stale overwrite", expectedVersion: 2 }), f.env))?.status).toBe(409);
    actor.email = "owner@example.test";
    expect(await (await handleV1(f.request(base, "GET", undefined, f.otherId), f.env))?.json()).toEqual([]);
    f.sqlite.prepare("UPDATE team_workspace_memberships SET status='removed',version=version+1 WHERE workspace_id=? AND user_id=?").run(f.workspaceId, actor.email);
    expect((await handleV1(f.request(`${base}/${id}/instructions`), f.env))?.status).toBe(404);
  });

  it("installs a provenance-linked draft, edits with CAS, and never grants member configuration writes", async () => {
    const f = await fixture();
    const installed = await handleSkillLibrary(f.request("/api/skills/library/pr-review-checklist/install", "POST"), f.env);
    expect(installed?.status).toBe(201);
    const { skillId } = await installed!.json() as { skillId: string };
    const list = await (await handleSkills(f.request("/api/skills"), f.env))!.json() as { skills: Array<{ instructions: string; sourceUrl: string }> };
    expect(list.skills).toMatchObject([{ status: "draft", version: 1, owned: true }]);
    const sourceUrl = list.skills[0]!.sourceUrl;
    expect(sourceUrl).toContain("https://");
    const edit = { name: "Reviewed checklist", instructions: "Team-specific checklist", sourceUrl, expectedVersion: 1 };
    expect((await handleSkills(f.request(`/api/skills/${skillId}`, "PATCH", edit), f.env))?.status).toBe(200);
    expect((await handleSkills(f.request(`/api/skills/${skillId}`, "PATCH", edit), f.env))?.status).toBe(409);
    expect(await (await handleSkills(f.request(`/api/skills/${skillId}`), f.env))?.json()).toMatchObject({ skill: { version: 2, status: "draft", sourceUrl } });
    actor.email = "member@example.test";
    expect((await handleSkillLibrary(f.request("/api/skills/library/pr-review-checklist/install", "POST"), f.env))?.status).toBe(403);
    expect((await handleSkills(f.request(`/api/skills/${skillId}/activate`, "POST", { version: 2, reviewedInstructions: edit.instructions }), f.env))?.status).toBe(403);
  });
});

describe("team onboarding drafts", () => {
  it.each(["read", "conflict"])("does not return a team draft when membership is removed during the final %s read", async (kind) => {
    const f = await fixture(); actor.email = "member@example.test";
    await f.onboarding();
    await f.onboarding("POST", { action: "save-draft", expectedRevision: 0, draftTask: { goal: "Scoped planning details" } });
    let reads = 0;
    const intercepted = interceptStorage(f, (sql) => sql.startsWith("SELECT draft_task_id") && sql.includes("user_onboarding_progress") && ++reads === (kind === "conflict" ? 2 : 1), () => removeActor(f));
    const response = kind === "read" ? await f.onboarding() : await f.onboarding("POST", { action: "save-draft", expectedRevision: 0, draftTask: { goal: "Stale overwrite" } });
    expect(intercepted()).toBe(true); expect(response?.status).toBe(404);
    expect(await response!.text()).not.toContain("Scoped planning details");
  });

  it.each(["init", "save-draft", "step", "dismiss", "resume"])("refuses the %s draft write if membership is removed immediately before SQL", async (kind) => {
    const f = await fixture(); actor.email = "member@example.test";
    if (kind !== "init") await f.onboarding();
    const before = kind === "init" ? [] : f.sqlite.prepare("SELECT * FROM user_onboarding_progress ORDER BY user_id").all();
    const intercepted = interceptStorage(f, (sql) => kind === "init" ? sql.startsWith("INSERT INTO user_onboarding_progress")
      : sql.startsWith("UPDATE user_onboarding_progress SET") && sql.includes("WHERE user_id=? AND revision=?"), () => removeActor(f));
    const response = kind === "init" ? await f.onboarding() : await f.onboarding("POST", { action: kind, expectedRevision: 0, ...(kind === "save-draft" ? { draftTask: { goal: "Unauthorized write" } } : kind === "step" ? { currentStep: "employee" } : {}) });
    expect(intercepted()).toBe(true); expect(response?.status).toBe(404);
    expect(f.sqlite.prepare("SELECT * FROM user_onboarding_progress ORDER BY user_id").all()).toEqual(before);
  });

  it("keeps drafts per immutable account and workspace with CAS, optional roles and no private readiness inheritance", async () => {
    const f = await fixture();
    const first = await f.onboarding(); expect(first?.status).toBe(200);
    expect(await first!.json()).toMatchObject({ revision: 0, evidence: { connectedProvider: null, successfulRun: null, acceptedDeliverable: null } });
    const saved = await f.onboarding("POST", { action: "save-draft", expectedRevision: 0, draftTask: { goal: "Draft a brief", employeeTemplateId: "finance", employeeTemplateVersion: 1 } });
    expect(await saved!.json()).toMatchObject({ revision: 1, draftTask: { goal: "Draft a brief", preparedAt: null, sourceRefs: [] } });
    expect((await f.onboarding("POST", { action: "save-draft", expectedRevision: 0, draftTask: { goal: "Stale" } }))?.status).toBe(409);
    expect((await f.onboarding("POST", { action: "prepare-task", expectedRevision: 1 }))?.status).toBe(422);
    expect((await f.onboarding("POST", { action: "save-draft", expectedRevision: 1, draftTask: { sourceIds: ["memsrc_private"] } }))?.status).toBe(400);
    expect(await (await f.onboarding("GET", undefined, f.otherId))!.json()).toMatchObject({ draftTask: null, revision: 0 });
    actor.email = "member@example.test";
    expect(await (await f.onboarding())!.json()).toMatchObject({ draftTask: null, revision: 0 });
    expect((await f.onboarding("POST", { action: "save-draft", expectedRevision: 0, draftTask: { audience: "My team" } }))?.status).toBe(200);
    f.sqlite.prepare("UPDATE team_workspace_memberships SET status='removed' WHERE workspace_id=? AND user_id=?").run(f.workspaceId, actor.email);
    expect((await f.onboarding())?.status).toBe(404);
    expect(f.evidence).not.toHaveBeenCalled();
  });

  it("accepts only the selected team's current employee version", async () => {
    const f = await fixture();
    const config = { name: "Research", harness: "opencode", instructions: "Review facts." };
    const team = await createCustomAgent(f.env, `team:${f.workspaceId}`, "research", config);
    const privateEmployee = await createCustomAgent(f.env, "self-hosted", "private", config);
    await f.onboarding();
    const save = (id: string, version: number) => f.onboarding("POST", { action: "save-draft", expectedRevision: 0, draftTask: { employeeId: id, employeeVersion: version } });
    expect((await save(privateEmployee.id, 1))?.status).toBe(400);
    await updateCustomAgent(f.env, `team:${f.workspaceId}`, team.id, { ...config, name: "New research" }, team.version);
    expect((await save(team.id, 1))?.status).toBe(400);
    expect((await save(team.id, 2))?.status).toBe(200);
  });
});
