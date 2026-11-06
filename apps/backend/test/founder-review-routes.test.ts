import { beforeEach, describe, expect, it, vi } from "vitest";
import { getFounderSkillLibraryEntry } from "@shiba/shared";
import type { Env } from "../src/env.js";
import { handleFounderSkills } from "../src/founder-skills-routes.js";
import { createCustomAgent } from "../src/custom-agents-store.js";
import { installSkillDefinition } from "../src/skill-library/install.js";
import { activateSkill, getSkill, reviewSkill } from "../src/skills-store.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { tickFounderReviewSchedules } from "../src/founder-review-schedules.js";

const identity = vi.hoisted(() => ({ owner: "owner@example.test", orgId: "self-hosted", principal: null as object | null,
  workspace: undefined as { workspaceId: string; userId: string; role: "owner" | "admin" | "member"; version: number; joinedAt: number } | undefined,
  revoked: false, native: true, accountId: "native-owner" }));
vi.mock("../src/org-request-auth.js", () => ({ resolveOrgForApiRequest: vi.fn(async () => identity.revoked ? Response.json({ error: "revoked" }, { status: 404 }) : ({ orgId: identity.orgId, principal: identity.principal, workspace: identity.workspace })) }));
vi.mock("../src/request-auth.js", () => ({ resolveUserId: vi.fn(async () => identity.owner) }));
vi.mock("@shiba/auth/better-auth", () => ({ resolveBetterAuthSessionAccount: vi.fn(async () => identity.native ? { emailVerified: true, policy: { email: identity.owner, accountId: identity.accountId } } : null) }));
const libraryId = "founder-stripe-revenue-pulse";
const base = `/api/founder-skills/${libraryId}/review-schedule`;
const request = (suffix = "", method = "GET", body?: unknown, headers?: Record<string, string>) => new Request(`https://shiba.test${base}${suffix}`, {
  method, headers: { Origin: "https://shiba.test", "Content-Type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
beforeEach(() => { identity.owner = "owner@example.test"; identity.orgId = "self-hosted"; identity.principal = null; identity.workspace = undefined; identity.revoked = false; identity.native = true; identity.accountId = "native-owner"; });
async function fixture(team = false) {
  const f = customAgentD1();
  f.sqlite.exec(`CREATE TABLE "user" (id TEXT PRIMARY KEY,email TEXT UNIQUE,emailVerified INTEGER);
    CREATE TABLE shiba_auth_account_policy (account_id TEXT PRIMARY KEY,email TEXT);
    INSERT INTO "user" VALUES ('native-owner','owner@example.test',1),('native-other','other@example.test',1);
    INSERT INTO shiba_auth_account_policy VALUES ('native-owner','owner@example.test'),('native-other','other@example.test');`);
  const env = { AGENT_AUDIT: f.database } as Env;
  for (const name of ["AI", "CodingOrchestrator", "Sandbox", "Automations", "OPENCONNECTOR_ADMIN_KEY", "SLACK_BOT_TOKEN", "TYPESAFE_API_KEY"])
    Object.defineProperty(env, name, { get: () => { throw new Error(`Unexpected execution access ${name}`); } });
  if (team) {
    identity.orgId = "team:ws_aaaaaaaaaaaaaaaaaaaaaaaa";
    identity.workspace = { workspaceId: "ws_aaaaaaaaaaaaaaaaaaaaaaaa", userId: identity.owner, role: "owner", version: 1, joinedAt: 1 };
    f.sqlite.exec(`CREATE TABLE team_workspace_memberships (tenant_id TEXT,workspace_id TEXT,user_id TEXT,role TEXT,status TEXT,version INTEGER);
      INSERT INTO team_workspace_memberships VALUES ('self-hosted','ws_aaaaaaaaaaaaaaaaaaaaaaaa','owner@example.test','owner','active',1);`);
  }
  const entry = getFounderSkillLibraryEntry(libraryId)!;
  const options = team ? { teamGrant: { ...identity.workspace!, role: "owner" as const } } : {};
  const install = await installSkillDefinition(env, identity.orgId, identity.owner, { slug: libraryId, version: "1.0.0", name: entry.name, instructions: entry.instructions, sourceUrl: entry.sourceUrl }, options);
  const skill = await getSkill(env, identity.orgId, identity.owner, install.skillId);
  await reviewSkill(env, identity.orgId, identity.owner, install.skillId, 1, skill!.content.instructions, Date.now(), options);
  await activateSkill(env, identity.orgId, identity.owner, install.skillId, 1, skill!.content.instructions, Date.now(), options);
  const employee = await createCustomAgent(env, identity.orgId, "review-writer", { name: "Review writer", harness: "opencode", instructions: "Sensitive current workspace profile." });
  const input = { mode: "review-draft", employeeId: employee.id, employeeVersion: 1, skillId: install.skillId, skillVersion: 1, cadence: "daily", localTime: "09:00", timezone: "UTC", expiresAt: Date.now() + 86_400_000, provider: null, allowedTools: [], destination: "private-dashboard" };
  return { ...f, env, input };
}

describe("founder review draft HTTP routes", () => {
  it("exercises actual HTTP prepare, reviewed enable, due receipt and private dismissal without executable automation", async () => {
    const f = await fixture();
    expect((await handleFounderSkills(request("/options"), f.env))?.status).toBe(200);
    const prepared = await handleFounderSkills(request("", "POST", f.input), f.env);
    expect(prepared?.status).toBe(201);
    const { schedule } = await prepared!.json() as { schedule: { version: number; digest: string; nextDueAt: number } };
    const enabled = await handleFounderSkills(request("/enable", "POST", { expectedVersion: schedule.version, digest: schedule.digest, reviewed: true }), f.env);
    expect(enabled?.status).toBe(200);
    const enabledBody = await enabled!.json() as { schedule: { version: number; digest: string; nextDueAt: number } };
    expect(await tickFounderReviewSchedules(f.env, enabledBody.schedule.nextDueAt)).toEqual({ created: 1, blocked: 0 });
    const state = await (await handleFounderSkills(request(), f.env))!.json() as { mode: string; executionAvailable: boolean; schedule: { version: number; digest: string }; occurrences: Array<{ id: string }> };
    expect(state).toMatchObject({ mode: "review-draft", executionAvailable: false });
    expect(state.occurrences).toHaveLength(1);
    const dismissed = await handleFounderSkills(request("/dismiss", "POST", { expectedVersion: state.schedule.version, digest: state.schedule.digest, reviewed: true, occurrenceId: state.occurrences[0]!.id }), f.env);
    expect(await dismissed!.json()).toMatchObject({ occurrences: [{ status: "dismissed" }] });
    identity.owner = "other@example.test";
    identity.accountId = "native-other";
    expect(await (await handleFounderSkills(request(), f.env))!.json()).toMatchObject({ schedule: null, occurrences: [] });
  });
  it("rejects API/automation identities, cross-origin writes, non-JSON and oversized requests before configuration", async () => {
    const f = await fixture();
    identity.principal = { principal: "agent:demo" };
    expect((await handleFounderSkills(request(), f.env))?.status).toBe(403);
    identity.principal = null; identity.owner = "automation:owner@example.test";
    expect((await handleFounderSkills(request(), f.env))?.status).toBe(403);
    identity.owner = "owner@example.test";
    expect((await handleFounderSkills(request("", "POST", f.input, { Origin: "https://evil.test" }), f.env))?.status).toBe(403);
    expect((await handleFounderSkills(request("", "POST", f.input, { "Content-Type": "text/plain" }), f.env))?.status).toBe(415);
    expect((await handleFounderSkills(request("", "POST", { data: "x".repeat(5000) }), f.env))?.status).toBe(413);
    expect((await handleFounderSkills(request("/enable", "POST", { expectedVersion: 1, digest: "a".repeat(64), reviewed: false }), f.env))?.status).toBe(400);
  });
  it("rejects a team member and drops a stored response if membership is revoked before the final guarded read", async () => {
    const f = await fixture(true);
    const prepared = await handleFounderSkills(request("", "POST", f.input), f.env);
    expect(prepared?.status).toBe(201);
    identity.workspace!.role = "member";
    expect((await handleFounderSkills(request(), f.env))?.status).toBe(403);
    identity.workspace!.role = "owner";
    const original = f.database.prepare.bind(f.database);
    f.database.prepare = (sql) => {
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement => ({ ...statement,
        bind: (...values: unknown[]) => wrap(statement.bind(...values)),
        all: async (...args: Parameters<D1PreparedStatement["all"]>) => {
          const result = await statement.all(...args);
          if (/FROM founder_review_occurrences/.test(sql)) {
            identity.revoked = true;
            f.sqlite.exec("UPDATE team_workspace_memberships SET status='removed',version=2");
          }
          return result;
        },
      } as D1PreparedStatement);
      return wrap(original(sql));
    };
    const result = await handleFounderSkills(request(), f.env);
    expect(result?.status).toBe(403);
    expect(await result?.text()).not.toContain("Sensitive current workspace profile");
  });
  it("hides immutable cached instructions and receipts if the source changes during the occurrence read", async () => {
    const f = await fixture();
    await handleFounderSkills(request("", "POST", f.input), f.env);
    const original = f.database.prepare.bind(f.database);
    f.database.prepare = (sql) => {
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement => ({ ...statement,
        bind: (...values: unknown[]) => wrap(statement.bind(...values)),
        all: async (...args: Parameters<D1PreparedStatement["all"]>) => {
          const result = await statement.all(...args);
          if (/FROM founder_review_occurrences/.test(sql)) f.sqlite.exec("UPDATE skills SET status='disabled'");
          return result;
        },
      } as D1PreparedStatement);
      return wrap(original(sql));
    };
    const result = await handleFounderSkills(request(), f.env);
    expect(await result!.json()).toMatchObject({ schedule: null, occurrences: [], unavailableReason: "schedule_sources_or_authority_changed" });
  });
  it("keeps Access-only identities unavailable without inventing a native UUID", async () => {
    const f = await fixture(); identity.native = false;
    const result = await handleFounderSkills(request(), f.env);
    expect(result?.status).toBe(403);
    expect(await result!.json()).toMatchObject({ error: "native_founder_schedule_required" });
  });
  it.each(["membership", "native-account"])("drops options when %s changes during its profile read", async (change) => {
    const f = await fixture(true), original = f.database.prepare.bind(f.database);
    f.database.prepare = (sql) => {
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement => ({ ...statement,
        bind: (...values: unknown[]) => wrap(statement.bind(...values)),
        all: async (...args: Parameters<D1PreparedStatement["all"]>) => {
          const result = await statement.all(...args);
          if (/FROM org_custom_agents/.test(sql)) {
            if (change === "membership") f.sqlite.exec("UPDATE team_workspace_memberships SET status='removed',version=2");
            else f.sqlite.exec(`DELETE FROM "user" WHERE id='native-owner'; DELETE FROM shiba_auth_account_policy WHERE account_id='native-owner';
              INSERT INTO "user" VALUES ('new-owner','owner@example.test',1); INSERT INTO shiba_auth_account_policy VALUES ('new-owner','owner@example.test');`);
          }
          return result;
        },
      } as D1PreparedStatement);
      return wrap(original(sql));
    };
    const result = await handleFounderSkills(request("/options"), f.env);
    expect(result?.status).toBe(403);
    expect(await result!.text()).not.toContain("Review writer");
  });
});
