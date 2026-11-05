import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { getFounderSkillLibraryEntry } from "@shiba/shared";
import type { Env } from "../src/env.js";
import { createCustomAgent } from "../src/custom-agents-store.js";
import { installSkillDefinition } from "../src/skill-library/install.js";
import { activateSkill, getSkill, reviewSkill } from "../src/skills-store.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import {
  decideFounderReviewSchedule, dismissFounderReviewOccurrence, nextFounderReviewDue,
  prepareFounderReviewSchedule, readFounderReviewSchedule, tickFounderReviewSchedules,
} from "../src/founder-review-schedules.js";

const libraryId = "founder-stripe-revenue-pulse";
const now = Date.UTC(2026, 10, 5, 7);
const due = Date.UTC(2026, 10, 5, 8);
const actor = { orgId: "self-hosted", ownerId: "owner@example.test", ownerAccountId: "native-owner" };
async function fixture(team = false) {
  const db = customAgentD1();
  db.sqlite.exec(`CREATE TABLE "user" (id TEXT PRIMARY KEY,email TEXT UNIQUE,emailVerified INTEGER);
    CREATE TABLE shiba_auth_account_policy (account_id TEXT PRIMARY KEY,email TEXT);
    INSERT INTO "user" VALUES ('native-owner','owner@example.test',1),('native-third','third@example.test',1);
    INSERT INTO shiba_auth_account_policy VALUES ('native-owner','owner@example.test'),('native-third','third@example.test');`);
  const env = { AGENT_AUDIT: db.database } as Env;
  for (const name of ["AI", "CodingOrchestrator", "Sandbox", "Automations", "GITHUB_TOKEN", "OPENCONNECTOR_ADMIN_KEY", "SLACK_BOT_TOKEN", "TYPESAFE_API_KEY"])
    Object.defineProperty(env, name, { get: () => { throw new Error(`Review drafts must not access ${name}`); } });
  const selected = team ? { ...actor, orgId: "team:ws_aaaaaaaaaaaaaaaaaaaaaaaa",
    teamGrant: { workspaceId: "ws_aaaaaaaaaaaaaaaaaaaaaaaa", userId: actor.ownerId, role: "owner" as const, version: 1 } } : actor;
  if (team) db.sqlite.exec(`CREATE TABLE team_workspace_memberships (tenant_id TEXT,workspace_id TEXT,user_id TEXT,role TEXT,status TEXT,version INTEGER);
    INSERT INTO team_workspace_memberships VALUES ('self-hosted','ws_aaaaaaaaaaaaaaaaaaaaaaaa','owner@example.test','owner','active',1);`);
  const entry = getFounderSkillLibraryEntry(libraryId)!;
  const installed = await installSkillDefinition(env, selected.orgId, selected.ownerId, { slug: libraryId, name: entry.name, instructions: entry.instructions, version: "1.0.0", sourceUrl: entry.sourceUrl }, "teamGrant" in selected ? { teamGrant: selected.teamGrant } : {});
  const options = "teamGrant" in selected ? { teamGrant: selected.teamGrant } : {};
  const skill = await getSkill(env, selected.orgId, selected.ownerId, installed.skillId);
  await reviewSkill(env, selected.orgId, selected.ownerId, installed.skillId, 1, skill!.content.instructions, now, options);
  await activateSkill(env, selected.orgId, selected.ownerId, installed.skillId, 1, skill!.content.instructions, now, options);
  const employee = await createCustomAgent(env, selected.orgId, "revenue-writer", { name: "Revenue writer", instructions: "Draft from reviewed inputs.", harness: "opencode" });
  const input = { mode: "review-draft" as const, employeeId: employee.id, employeeVersion: 1, skillId: installed.skillId, skillVersion: 1,
    cadence: "daily" as const, localTime: "08:00", timezone: "UTC", expiresAt: now + 30 * 86_400_000,
    destination: "private-dashboard" as const, allowedTools: [] as [], provider: null };
  return { ...db, env, actor: selected, input, employee, skill: skill! };
}
const decision = (schedule: { version: number; digest: string }) => ({ expectedVersion: schedule.version, digest: schedule.digest, reviewed: true as const });

describe("founder storage-only review schedules", () => {
  it("requires reviewed active installed instructions and a current available profile", async () => {
    const f = await fixture();
    await expect(prepareFounderReviewSchedule(f.env, f.actor, libraryId, { ...f.input, employeeVersion: 2 }, now)).rejects.toThrow("employee_version_changed");
    await expect(prepareFounderReviewSchedule(f.env, f.actor, libraryId, { ...f.input, skillVersion: 2 }, now)).rejects.toThrow("reviewed_active_founder_skill_required");
    f.sqlite.prepare("UPDATE skills SET status='disabled'").run();
    await expect(prepareFounderReviewSchedule(f.env, f.actor, libraryId, f.input, now)).rejects.toThrow("reviewed_active_founder_skill_required");
  });
  it.each([{ provider: "chatgpt" }, { allowedTools: ["integrations.execute"] }, { destination: "slack" }, { timezone: "invented/zone" }, { localTime: "08:03" }, { billingApproved: true }])("rejects unsupported execution or ambiguous configuration %j", async (change) => {
    const f = await fixture();
    await expect(prepareFounderReviewSchedule(f.env, f.actor, libraryId, { ...f.input, ...change }, now)).rejects.toThrow("invalid_review_schedule");
  });
  it("prepares but never runs, requires the exact current review decision, and expires an unreviewed draft", async () => {
    const f = await fixture();
    const draft = await prepareFounderReviewSchedule(f.env, f.actor, libraryId, f.input, now);
    expect(draft).toMatchObject({ state: "draft", nextDueAt: due, contract: { provider: null, allowedTools: [], destination: "private-dashboard" } });
    expect(await tickFounderReviewSchedules(f.env, due)).toEqual({ created: 0, blocked: 0 });
    await expect(decideFounderReviewSchedule(f.env, f.actor, libraryId, "enable", { ...decision(draft), digest: "f".repeat(64) }, now)).rejects.toThrow("schedule_version_conflict");
    await expect(decideFounderReviewSchedule(f.env, f.actor, libraryId, "enable", decision(draft), now + 15 * 60_000)).rejects.toThrow("schedule_review_expired_or_changed");
    expect(f.sqlite.prepare("SELECT COUNT(*) AS n FROM founder_review_occurrences").get()).toEqual({ n: 0 });
  });
  it("durably deduplicates due drafts across repeated ticks and reconstructed callers, with no run or approval dispatch", async () => {
    const f = await fixture();
    const draft = await prepareFounderReviewSchedule(f.env, f.actor, libraryId, f.input, now);
    const enabled = await decideFounderReviewSchedule(f.env, f.actor, libraryId, "enable", decision(draft), now);
    expect(await Promise.all([tickFounderReviewSchedules(f.env, due), tickFounderReviewSchedules(f.env, due)])).toEqual(expect.arrayContaining([{ created: 1, blocked: 0 }, { created: 0, blocked: 0 }]));
    expect(await tickFounderReviewSchedules({ AGENT_AUDIT: f.database }, due + 60_000)).toEqual({ created: 0, blocked: 0 });
    const observed = await readFounderReviewSchedule(f.env, f.actor, libraryId);
    expect(observed.occurrences).toEqual([expect.objectContaining({ id: `${enabled.id}:${enabled.version}:${due}`, scheduledAt: due, status: "pending", digest: enabled.digest })]);
    expect(observed.schedule?.nextDueAt).toBe(due + 86_400_000);
    expect(observed.occurrences[0]!.task).toContain("authorized integration results when available");
  });
  it("retains one pending draft across delayed/overlapping occurrences and coalesces an outage without a backlog", async () => {
    const f = await fixture();
    const draft = await prepareFounderReviewSchedule(f.env, f.actor, libraryId, f.input, now);
    const enabled = await decideFounderReviewSchedule(f.env, f.actor, libraryId, "enable", decision(draft), now);
    expect(await tickFounderReviewSchedules(f.env, due + 3 * 86_400_000)).toEqual({ created: 1, blocked: 0 });
    expect(await tickFounderReviewSchedules(f.env, due + 4 * 86_400_000)).toEqual({ created: 0, blocked: 0 });
    const pending = await readFounderReviewSchedule(f.env, f.actor, libraryId);
    expect(pending.occurrences).toHaveLength(1);
    expect(pending.occurrences[0]!.scheduledAt).toBe(due);
    expect(pending.schedule!.nextDueAt).toBe(due + 5 * 86_400_000);
    await dismissFounderReviewOccurrence(f.env, f.actor, libraryId, pending.occurrences[0]!.id, decision(enabled));
    expect(await tickFounderReviewSchedules(f.env, due + 5 * 86_400_000)).toEqual({ created: 1, blocked: 0 });
  });
  it("handles a lost committed batch response without making a duplicate proposal", async () => {
    const f = await fixture();
    const draft = await prepareFounderReviewSchedule(f.env, f.actor, libraryId, f.input, now);
    await decideFounderReviewSchedule(f.env, f.actor, libraryId, "enable", decision(draft), now);
    const original = f.database.batch.bind(f.database);
    f.database.batch = async (statements) => { await original(statements); throw new Error("response lost after commit"); };
    await expect(tickFounderReviewSchedules(f.env, due)).rejects.toThrow("response lost");
    f.database.batch = original;
    expect(await tickFounderReviewSchedules(f.env, due)).toEqual({ created: 0, blocked: 0 });
    expect(f.sqlite.prepare("SELECT COUNT(*) AS n FROM founder_review_occurrences").get()).toEqual({ n: 1 });
  });
  it("retries an uncommitted storage failure without advancing due or creating partial receipts", async () => {
    const f = await fixture();
    const draft = await prepareFounderReviewSchedule(f.env, f.actor, libraryId, f.input, now);
    await decideFounderReviewSchedule(f.env, f.actor, libraryId, "enable", decision(draft), now);
    const original = f.database.batch.bind(f.database);
    f.database.batch = async () => { throw new Error("storage unavailable before commit"); };
    await expect(tickFounderReviewSchedules(f.env, due)).rejects.toThrow("storage unavailable");
    expect(f.sqlite.prepare("SELECT next_due_at FROM founder_review_schedules").get()).toEqual({ next_due_at: due });
    f.database.batch = original;
    expect(await tickFounderReviewSchedules(f.env, due)).toEqual({ created: 1, blocked: 0 });
  });
  it("uses CAS on pause/resume/revoke, cancels pending drafts and never catches up while stopped", async () => {
    const f = await fixture();
    const draft = await prepareFounderReviewSchedule(f.env, f.actor, libraryId, f.input, now);
    const enabled = await decideFounderReviewSchedule(f.env, f.actor, libraryId, "enable", decision(draft), now);
    await tickFounderReviewSchedules(f.env, due);
    const paused = await decideFounderReviewSchedule(f.env, f.actor, libraryId, "pause", decision(enabled), due + 1);
    await expect(decideFounderReviewSchedule(f.env, f.actor, libraryId, "resume", decision(enabled), due + 2)).rejects.toThrow("schedule_version_conflict");
    expect(await tickFounderReviewSchedules(f.env, due + 86_400_000)).toEqual({ created: 0, blocked: 0 });
    const resumed = await decideFounderReviewSchedule(f.env, f.actor, libraryId, "resume", decision(paused), due + 86_400_000 + 1);
    expect(resumed.nextDueAt).toBe(due + 2 * 86_400_000);
    const revoked = await decideFounderReviewSchedule(f.env, f.actor, libraryId, "revoke", decision(resumed), due + 86_400_000 + 2);
    expect(revoked.state).toBe("revoked");
    expect((await readFounderReviewSchedule(f.env, f.actor, libraryId)).occurrences[0]!.status).toBe("cancelled");
    await expect(decideFounderReviewSchedule(f.env, f.actor, libraryId, "resume", decision(revoked), due + 86_400_000 + 3)).rejects.toThrow();
  });
  it.each(["skill", "profile", "install", "expiry", "membership"])("blocks a due draft when %s changes, without exposing cached source text", async (source) => {
    const f = await fixture(source === "membership");
    const draft = await prepareFounderReviewSchedule(f.env, f.actor, libraryId, f.input, now);
    await decideFounderReviewSchedule(f.env, f.actor, libraryId, "enable", decision(draft), now);
    if (source === "skill") f.sqlite.exec("UPDATE skills SET status='disabled'");
    if (source === "profile") f.sqlite.exec("UPDATE org_custom_agents SET version=2");
    if (source === "install") f.sqlite.exec("DELETE FROM skill_installs");
    if (source === "membership") f.sqlite.exec("UPDATE team_workspace_memberships SET status='removed',version=2");
    const at = source === "expiry" ? f.input.expiresAt : due;
    expect(await tickFounderReviewSchedules(f.env, at)).toEqual({ created: 0, blocked: 1 });
    if (source === "membership") await expect(readFounderReviewSchedule(f.env, f.actor, libraryId)).rejects.toThrow("founder_authority_changed");
    else {
      const read = await readFounderReviewSchedule(f.env, f.actor, libraryId);
      expect(read.occurrences).toEqual([]);
      if (source !== "expiry") expect(read.schedule).toBeNull();
    }
    expect(f.sqlite.prepare("SELECT state FROM founder_review_schedules").get()).toEqual({ state: "blocked" });
  });
  it("rechecks pins and stop state inside the exact occurrence batch", async () => {
    for (const change of ["membership", "skill", "stop"] as const) {
      const f = await fixture(true);
      const draft = await prepareFounderReviewSchedule(f.env, f.actor, libraryId, f.input, now);
      await decideFounderReviewSchedule(f.env, f.actor, libraryId, "enable", decision(draft), now);
      const original = f.database.batch.bind(f.database);
      f.database.batch = (statements) => {
        if (change === "membership") f.sqlite.exec("UPDATE team_workspace_memberships SET status='removed',version=2");
        if (change === "skill") f.sqlite.exec("UPDATE skills SET status='disabled'");
        if (change === "stop") f.sqlite.exec("UPDATE founder_review_schedules SET state='revoked',version=version+1");
        return original(statements);
      };
      expect((await tickFounderReviewSchedules(f.env, due)).created).toBe(0);
      expect(f.sqlite.prepare("SELECT COUNT(*) AS n FROM founder_review_occurrences").get()).toEqual({ n: 0 });
    }
  });
  it("isolates owner/org reads and refuses a grantless or changed team actor", async () => {
    const f = await fixture(true);
    await prepareFounderReviewSchedule(f.env, f.actor, libraryId, f.input, now);
    expect(await readFounderReviewSchedule(f.env, actor, libraryId)).toEqual({ schedule: null, occurrences: [] });
    await expect(readFounderReviewSchedule(f.env, { ...actor, orgId: f.actor.orgId }, libraryId)).rejects.toThrow("workspace_authority_changed");
    expect(await readFounderReviewSchedule(f.env, { orgId: "self-hosted", ownerId: "third@example.test", ownerAccountId: "native-third" }, libraryId)).toEqual({ schedule: null, occurrences: [] });
    f.sqlite.exec("INSERT INTO team_workspace_memberships VALUES ('self-hosted','ws_aaaaaaaaaaaaaaaaaaaaaaaa','third@example.test','admin','active',1)");
    expect(await readFounderReviewSchedule(f.env, { orgId: f.actor.orgId, ownerId: "third@example.test", ownerAccountId: "native-third", teamGrant: { workspaceId: "ws_aaaaaaaaaaaaaaaaaaaaaaaa", userId: "third@example.test", role: "admin", version: 1 } }, libraryId)).toEqual({ schedule: null, occurrences: [] });
  });
  it("binds each replacement configuration revision into a new review hash and refuses stale reconfiguration", async () => {
    const f = await fixture();
    const first = await prepareFounderReviewSchedule(f.env, f.actor, libraryId, f.input, now);
    await expect(prepareFounderReviewSchedule(f.env, f.actor, libraryId, f.input, now)).rejects.toThrow("schedule_version_conflict");
    const second = await prepareFounderReviewSchedule(f.env, f.actor, libraryId, { ...f.input, expectedVersion: first.version }, now);
    expect(second.id).toBe(first.id); expect(second.version).toBe(2); expect(second.digest).not.toBe(first.digest);
    await expect(decideFounderReviewSchedule(f.env, f.actor, libraryId, "enable", decision(first), now)).rejects.toThrow("schedule_version_conflict");
  });
  it("blocks an old recipe revision and permits content-free revocation after a pinned source is disabled", async () => {
    const f = await fixture();
    const draft = await prepareFounderReviewSchedule(f.env, f.actor, libraryId, f.input, now);
    await decideFounderReviewSchedule(f.env, f.actor, libraryId, "enable", decision(draft), now);
    const stored = f.sqlite.prepare("SELECT contract_json FROM founder_review_schedules").get() as { contract_json: string };
    const contract = JSON.parse(stored.contract_json); contract.recipeSha256 = "f".repeat(64);
    f.sqlite.prepare("UPDATE founder_review_schedules SET contract_json=?").run(JSON.stringify(contract));
    expect(await tickFounderReviewSchedules(f.env, due)).toEqual({ created: 0, blocked: 1 });
    const state = await readFounderReviewSchedule(f.env, f.actor, libraryId);
    expect(state).toMatchObject({ schedule: null, occurrences: [], unavailableReason: "recipe_changed", staleSchedule: { state: "blocked" } });
    const revoked = await decideFounderReviewSchedule(f.env, f.actor, libraryId, "revoke", { expectedVersion: state.staleSchedule!.version, digest: state.staleSchedule!.digest, reviewed: true }, due + 1);
    expect(revoked.state).toBe("revoked");
  });
  it("rejects source revocation at the exact prepare write and does not persist a partial job", async () => {
    const f = await fixture(true);
    const original = f.database.batch.bind(f.database);
    f.database.batch = (statements) => { f.sqlite.exec("UPDATE team_workspace_memberships SET status='removed',version=2"); return original(statements); };
    await expect(prepareFounderReviewSchedule(f.env, f.actor, libraryId, f.input, now)).rejects.toThrow("schedule_sources_or_version_changed");
    expect(f.sqlite.prepare("SELECT COUNT(*) AS n FROM founder_review_schedules").get()).toEqual({ n: 0 });
  });
  it("keeps the append-only migration compatible with the idempotent runtime schema", async () => {
    const f = await fixture();
    f.sqlite.exec(readFileSync(new URL("../migrations/0012_founder_review_schedules.sql", import.meta.url), "utf8"));
    await prepareFounderReviewSchedule(f.env, f.actor, libraryId, f.input, now);
    expect(f.sqlite.prepare("SELECT state FROM founder_review_schedules").get()).toEqual({ state: "draft" });
  });
  it("does not transfer private receipts to a recreated native account with the same email and unchanged team membership", async () => {
    const f = await fixture(true);
    const draft = await prepareFounderReviewSchedule(f.env, f.actor, libraryId, f.input, now);
    await decideFounderReviewSchedule(f.env, f.actor, libraryId, "enable", decision(draft), now);
    await tickFounderReviewSchedules(f.env, due);
    f.sqlite.exec(`DELETE FROM "user" WHERE id='native-owner'; DELETE FROM shiba_auth_account_policy WHERE account_id='native-owner';
      INSERT INTO "user" VALUES ('replacement-owner','owner@example.test',1);
      INSERT INTO shiba_auth_account_policy VALUES ('replacement-owner','owner@example.test');`);
    expect(await readFounderReviewSchedule(f.env, { ...f.actor, ownerAccountId: "replacement-owner" }, libraryId)).toEqual({ schedule: null, occurrences: [] });
    await expect(readFounderReviewSchedule(f.env, f.actor, libraryId)).rejects.toThrow("founder_authority_changed");
    expect(await tickFounderReviewSchedules(f.env, due + 86_400_000)).toEqual({ created: 0, blocked: 1 });
    expect(f.sqlite.prepare("SELECT owner_account_id,state FROM founder_review_schedules").get()).toEqual({ owner_account_id: "native-owner", state: "blocked" });
    expect(f.sqlite.prepare("SELECT status FROM founder_review_occurrences").get()).toEqual({ status: "cancelled" });
  });
  it("fences the exact prepare mutation against a native account losing verification", async () => {
    const f = await fixture();
    const original = f.database.batch.bind(f.database);
    f.database.batch = (statements) => { f.sqlite.exec('UPDATE "user" SET emailVerified=0'); return original(statements); };
    await expect(prepareFounderReviewSchedule(f.env, f.actor, libraryId, f.input, now)).rejects.toThrow("schedule_sources_or_version_changed");
    expect(f.sqlite.prepare("SELECT COUNT(*) AS n FROM founder_review_schedules").get()).toEqual({ n: 0 });
  });
  it("refreshes the production decision clock after awaited recipe validation", async () => {
    const f = await fixture(), draft = await prepareFounderReviewSchedule(f.env, f.actor, libraryId, f.input, now);
    let clock = draft.reviewExpiresAt - 1;
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    const time = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const digest = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, input) => {
      const result = await originalDigest(algorithm, input); clock += 2; return result;
    });
    try {
      await expect(decideFounderReviewSchedule(f.env, f.actor, libraryId, "enable", decision(draft))).rejects.toThrow("schedule_review_expired_or_changed");
      expect(f.sqlite.prepare("SELECT state FROM founder_review_schedules").get()).toEqual({ state: "draft" });
    } finally { digest.mockRestore(); time.mockRestore(); }
  });
  it("rechecks preview expiry at the actual D1 mutation even if the Worker precheck was valid", async () => {
    const f = await fixture(), at = Date.now();
    const draft = await prepareFounderReviewSchedule(f.env, f.actor, libraryId, { ...f.input, expiresAt: at + 86_400_000 }, at);
    // A deterministic database clock models delay after the Worker precheck.
    f.sqlite.function("julianday", (_value: unknown) => 2_440_587.5 + (draft.reviewExpiresAt + 100) / 86_400_000);
    await expect(decideFounderReviewSchedule(f.env, f.actor, libraryId, "enable", decision(draft))).rejects.toThrow("schedule_sources_or_version_changed");
    expect(f.sqlite.prepare("SELECT state FROM founder_review_schedules").get()).toEqual({ state: "draft" });
  });
});

describe("founder cadence uses the existing scheduler matcher", () => {
  it("uses exact IANA daily/weekly instants and skips nonexistent DST wall times", () => {
    expect(nextFounderReviewDue({ localTime: "08:00", timezone: "America/Los_Angeles", cron: "0 8 * * *" }, Date.UTC(2026, 10, 5, 7))).toBe(Date.UTC(2026, 10, 5, 16));
    expect(nextFounderReviewDue({ localTime: "09:00", timezone: "UTC", cron: "0 9 * * 1" }, Date.UTC(2026, 10, 5))).toBe(Date.UTC(2026, 10, 9, 9));
    expect(nextFounderReviewDue({ localTime: "02:30", timezone: "America/New_York", cron: "30 2 * * *" }, Date.UTC(2026, 2, 8, 0))).toBe(Date.UTC(2026, 2, 9, 6, 30));
  });
  it("preserves repeated-wall-time cron instants rather than inventing a nonexistent offset", () => {
    const contract = { localTime: "01:30", timezone: "America/New_York", cron: "30 1 * * *" };
    expect(nextFounderReviewDue(contract, Date.UTC(2026, 10, 1, 0))).toBe(Date.UTC(2026, 10, 1, 5, 30));
    expect(nextFounderReviewDue(contract, Date.UTC(2026, 10, 1, 5, 30))).toBe(Date.UTC(2026, 10, 1, 6, 30));
  });
});
