import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { handleSkillLibrary } from "../src/skill-library-routes.js";
import { handleSkills } from "../src/skills-routes.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { activateSkill, disableSkill, getSkill, resolveSkillPins, reviewSkill } from "../src/skills-store.js";
import { SKILL_LIBRARY } from "../src/skill-library/index.js";

const authState = vi.hoisted(() => ({
  dashboard: false,
  principal: null as null | { principal: string; orgId: string; scopes: string[] },
}));

vi.mock("../src/request-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/request-auth.js")>();
  return { ...actual, isAuthorizedRequest: vi.fn(async () => authState.dashboard) };
});

vi.mock("../src/v1-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/v1-auth.js")>();
  return { ...actual, authorizeV1Request: vi.fn(async () => authState.principal) };
});

const headers = (user = "owner@example.test") => ({
  "CF-Access-Authenticated-User-Email": user,
  "content-type": "application/json",
});
const libraryRequest = (path: string, method = "GET", body?: unknown, user?: string) => new Request(
  `https://shiba.test/api/skills/library${path}`,
  { method, headers: headers(user), ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
);
const env = (db = customAgentD1().database) => ({
  REQUIRE_ACCESS: true,
  AGENT_AUDIT: db,
  Spaces: undefined,
} as unknown as Env);

beforeEach(() => {
  authState.dashboard = true;
  authState.principal = null;
});

describe("skill library routes", () => {
  it.each(SKILL_LIBRARY.filter((entry) => entry.tags.includes("draft-workflow")))("keeps $slug installs private, idempotent and unusable before review", async (entry) => {
    const bindings = env();
    const first = await handleSkillLibrary(libraryRequest(`/${entry.slug}/install`, "POST"), bindings);
    expect(first?.status).toBe(201);
    if (!first) throw new Error("Missing install response");
    const body = await first.json() as { skillId: string; status: string; skill: { status: string; version: number } };
    expect(body).toMatchObject({ status: "draft", skill: { status: "draft", version: 1 } });
    const stored = await getSkill(bindings, "self-hosted", "owner@example.test", body.skillId);
    expect(stored?.content.instructions).toBe(entry.instructions);
    expect(stored?.activeVersion).toBeUndefined();
    expect(await getSkill(bindings, "self-hosted", "other@example.test", body.skillId)).toBeNull();
    const pins = [{ skillId: body.skillId, version: 1 }];
    expect(await resolveSkillPins(bindings, "self-hosted", "owner@example.test", pins)).toBeNull();
    await expect(activateSkill(bindings, "self-hosted", "owner@example.test", body.skillId, 1, entry.instructions)).rejects.toThrow("review_required");

    const again = await handleSkillLibrary(libraryRequest(`/${entry.slug}/install`, "POST"), bindings);
    expect(again?.status).toBe(200);
    expect(await again?.json()).toMatchObject({ skillId: body.skillId, status: "draft" });
    const catalog = await handleSkillLibrary(libraryRequest(""), bindings);
    if (!catalog) throw new Error("Missing catalog response");
    const listed = await catalog.json() as { skills: Array<{ slug: string; installedStatus?: string; installedSkillId?: string }> };
    expect(listed.skills.find((skill) => skill.slug === entry.slug)).toMatchObject({ installedStatus: "draft", installedSkillId: body.skillId });

    await reviewSkill(bindings, "self-hosted", "owner@example.test", body.skillId, 1, entry.instructions);
    expect(await resolveSkillPins(bindings, "self-hosted", "owner@example.test", pins)).toBeNull();
    await activateSkill(bindings, "self-hosted", "owner@example.test", body.skillId, 1, entry.instructions);
    expect((await resolveSkillPins(bindings, "self-hosted", "owner@example.test", pins))?.pins).toMatchObject(pins);
    await disableSkill(bindings, "self-hosted", "owner@example.test", body.skillId);
    expect(await resolveSkillPins(bindings, "self-hosted", "owner@example.test", pins)).toBeNull();
  });

  it.each(SKILL_LIBRARY.filter((entry) => entry.tags.includes("draft-workflow")))("denies read-only token installation of $slug", async (entry) => {
    authState.dashboard = false;
    authState.principal = { principal: "read-only", orgId: "self-hosted", scopes: ["api:read"] };
    expect((await handleSkillLibrary(libraryRequest(`/${entry.slug}/install`, "POST"), env()))?.status).toBe(403);
  });

  it.each(["inbox-triage", "meeting-brief", "document-research", "task-planning", "weekly-work-summary", "social-post-drafts"])("installs %s as an owner-scoped draft without activation", async (slug) => {
    const bindings = env();
    const response = await handleSkillLibrary(libraryRequest(`/${slug}/install`, "POST"), bindings);
    expect(response?.status).toBe(201);
    const body = await response!.json() as { skillId: string; skill: { status: string } };
    expect(body.skill.status).toBe("draft");
    const stored = await getSkill(bindings, "self-hosted", "owner@example.test", body.skillId);
    expect(stored?.status).toBe("draft");
    expect(stored?.content.instructions).toContain("exact-action human approval");
    expect(await getSkill(bindings, "self-hosted", "other@example.test", body.skillId)).toBeNull();
  });

  it.each(["disabled", "missing"])("reports current readiness instead of showing %s drafts as installed", async (state) => {
    const db = customAgentD1();
    const bindings = env(db.database);
    const installed = await handleSkillLibrary(libraryRequest("/pr-review-checklist/install", "POST"), bindings);
    const { skillId } = await installed!.json() as { skillId: string };
    const skill = await getSkill(bindings, "self-hosted", "owner@example.test", skillId);
    if (!skill) throw new Error("Missing installed draft");
    await reviewSkill(bindings, "self-hosted", "owner@example.test", skillId, 1, skill.content.instructions);
    await activateSkill(bindings, "self-hosted", "owner@example.test", skillId, 1, skill.content.instructions);
    const catalog = async () => (await (await handleSkillLibrary(libraryRequest(""), bindings))!.json() as { skills: Array<{ slug: string; installed: boolean; installedStatus?: string; installedSkillId?: string }> }).skills.find((entry) => entry.slug === "pr-review-checklist");
    expect(await catalog()).toMatchObject({ installed: true, installedStatus: "active", installedSkillId: skillId });
    if (state === "disabled") await disableSkill(bindings, "self-hosted", "owner@example.test", skillId);
    else db.sqlite.prepare("DELETE FROM skills WHERE id=?").run(skillId);
    expect(await catalog()).toEqual(expect.objectContaining({ installed: false }));
    expect((await catalog())?.installedSkillId).toBeUndefined();
  });
  it("requires authentication for library reads", async () => {
    authState.dashboard = false;
    authState.principal = null;
    const response = await handleSkillLibrary(libraryRequest(""), env());
    expect(response?.status).toBe(401);
  });

  it("lists catalog entries as not installed, installs draft skills idempotently, and uninstalls", async () => {
    const bindings = env();
    const list = await handleSkillLibrary(libraryRequest(""), bindings);
    expect(list?.status).toBe(200);
    const listed = await list!.json() as { skills: Array<{ slug: string; installed: boolean }> };
    expect(listed.skills.every((skill) => skill.installed === false)).toBe(true);

    const first = await handleSkillLibrary(libraryRequest("/pr-review-checklist/install", "POST"), bindings);
    expect(first?.status).toBe(201);
    const firstBody = await first!.json() as { skillId: string; skill: { status: string } };
    expect(firstBody.skill.status).toBe("draft");

    const second = await handleSkillLibrary(libraryRequest("/pr-review-checklist/install", "POST"), bindings);
    expect(second?.status).toBe(200);
    const secondBody = await second!.json() as { skillId: string };
    expect(secondBody.skillId).toBe(firstBody.skillId);

    const afterInstall = await handleSkillLibrary(libraryRequest(""), bindings);
    const installedList = await afterInstall!.json() as { skills: Array<{ slug: string; installed: boolean }> };
    expect(installedList.skills.find((skill) => skill.slug === "pr-review-checklist")?.installed).toBe(true);

    const removed = await handleSkillLibrary(libraryRequest("/pr-review-checklist/install", "DELETE"), bindings);
    expect(removed?.status).toBe(200);
    const afterRemove = await handleSkillLibrary(libraryRequest(""), bindings);
    const removedList = await afterRemove!.json() as { skills: Array<{ slug: string; installed: boolean }> };
    expect(removedList.skills.find((skill) => skill.slug === "pr-review-checklist")?.installed).toBe(false);
  });

  it("shows and removes only the caller's installs within a shared dashboard org", async () => {
    const bindings = env();
    const first = await handleSkillLibrary(libraryRequest("/pr-review-checklist/install", "POST"), bindings);
    expect(first?.status).toBe(201);
    const otherList = await handleSkillLibrary(libraryRequest("", "GET", undefined, "other@example.test"), bindings);
    const otherBody = await otherList?.json() as { skills: Array<{ installed: boolean }> };
    expect(otherBody.skills.every((skill) => !skill.installed)).toBe(true);
    expect((await handleSkillLibrary(libraryRequest("/pr-review-checklist/install", "DELETE", undefined, "other@example.test"), bindings))?.status).toBe(404);
    const second = await handleSkillLibrary(libraryRequest("/pr-review-checklist/install", "POST", undefined, "other@example.test"), bindings);
    expect(second?.status).toBe(201);
    const firstBody = await first?.json() as { skillId: string };
    const secondBody = await second?.json() as { skillId: string };
    expect(secondBody.skillId).not.toBe(firstBody.skillId);
    const again = await handleSkillLibrary(libraryRequest("/pr-review-checklist/install", "POST"), bindings);
    expect((await again?.json() as { skillId: string }).skillId).toBe(firstBody.skillId);
  });

  it("does not treat library paths as versioned skill ids", async () => {
    const bindings = env();
    expect(await handleSkillLibrary(libraryRequest(""), bindings)).not.toBeNull();
    expect((await handleSkills(new Request("https://shiba.test/api/skills/library", { headers: headers() }), bindings))?.status).toBe(404);
  });

  it("refuses install for read-only v1 tokens", async () => {
    authState.dashboard = false;
    authState.principal = { principal: "read-only", orgId: "self-hosted", scopes: ["api:read"] };
    const response = await handleSkillLibrary(libraryRequest("/write-tests-first/install", "POST"), env());
    expect(response?.status).toBe(403);
  });
});
