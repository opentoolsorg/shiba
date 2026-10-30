import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { handleSkills } from "../src/skills-routes.js";
import { resolveSkillPins } from "../src/skills-store.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

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
const request = (path: string, method = "GET", body?: unknown, user?: string) => new Request(
  `https://shiba.test/api/skills${path}`,
  { method, headers: headers(user), ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
);
const env = (db = customAgentD1().database) => ({ REQUIRE_ACCESS: true, AGENT_AUDIT: db } as unknown as Env);
const content = (name: string, instructions: string) => ({ name, instructions, sourceUrl: "https://example.test/skill" });

beforeEach(() => {
  authState.dashboard = true;
  authState.principal = null;
});

describe("authenticated versioned skills", () => {
  it("creates a draft, reloads it, preserves immutable versions, reviews and activates exact text", async () => {
    const bindings = env();
    const createdResponse = await handleSkills(request("", "POST", content("Security", "Check authorization.")), bindings);
    expect(createdResponse?.status).toBe(201);
    const created = (await createdResponse!.json() as { skill: Record<string, unknown> }).skill;
    expect(created).toMatchObject({ version: 1, status: "draft", owned: true, instructions: "Check authorization." });
    const id = String(created.id);

    const reloaded = await handleSkills(request(""), bindings);
    expect(await reloaded?.json()).toMatchObject({ skills: [{ id, version: 1, status: "draft" }] });

    const updated = await handleSkills(request(`/${id}`, "PATCH", {
      ...content("Security checklist", "Check authorization.\nTest tenant boundaries."), expectedVersion: 1,
    }), bindings);
    expect(updated?.status).toBe(200);
    expect(await updated?.json()).toMatchObject({ skill: { version: 2, status: "draft" } });
    expect((await handleSkills(request(`/${id}`, "PATCH", { ...content("Race", "New text"), expectedVersion: 1 }), bindings))?.status).toBe(409);

    const history = await handleSkills(request(`/${id}/versions`), bindings);
    expect(await history?.json()).toMatchObject({ versions: [
      { version: 2, instructions: "Check authorization.\nTest tenant boundaries." },
      { version: 1, instructions: "Check authorization." },
    ] });
    const wrongReview = await handleSkills(request(`/${id}/review`, "POST", { version: 2, reviewedInstructions: "different text" }), bindings);
    expect(wrongReview?.status).toBe(409);
    const reviewedText = "Check authorization.\nTest tenant boundaries.";
    const reviewed = await handleSkills(request(`/${id}/review`, "POST", { version: 2, reviewedInstructions: reviewedText }), bindings);
    expect(await reviewed?.json()).toMatchObject({ skill: { status: "review", reviewedVersion: 2 } });
    const activated = await handleSkills(request(`/${id}/activate`, "POST", { version: 2, reviewedInstructions: reviewedText }), bindings);
    expect(await activated?.json()).toMatchObject({ skill: { status: "active", activeVersion: 2 } });

    const resolved = await resolveSkillPins(bindings, "self-hosted", "owner@example.test", [{ skillId: id, version: 2 }]);
    expect(resolved).toMatchObject({ pins: [{ skillId: id, version: 2, name: "Security checklist" }] });
    expect(resolved?.instructions).toContain("Check authorization.\nTest tenant boundaries.");
    expect(resolved?.instructions).toContain(`${id}@2`);
  });

  it("filters org discovery and hides another owner's drafts and inactive versions", async () => {
    const bindings = env();
    const createdResponse = await handleSkills(request("", "POST", content("Private draft", "Do not expose.")), bindings);
    const created = (await createdResponse!.json() as { skill: { id: string } }).skill;
    const userB = await handleSkills(request("", "GET", undefined, "other@example.test"), bindings);
    expect((await userB?.json() as { skills: unknown[] }).skills).toEqual([]);
    expect((await handleSkills(request(`/${created.id}`, "GET", undefined, "other@example.test"), bindings))?.status).toBe(404);

    await handleSkills(request(`/${created.id}/review`, "POST", { version: 1, reviewedInstructions: "Do not expose." }), bindings);
    await handleSkills(request(`/${created.id}/activate`, "POST", { version: 1, reviewedInstructions: "Do not expose." }), bindings);
    const shared = await handleSkills(request("", "GET", undefined, "other@example.test"), bindings);
    expect(await shared?.json()).toMatchObject({ skills: [{ id: created.id, status: "active", owned: false }] });
    expect(await (await handleSkills(request(`/${created.id}/versions`, "GET", undefined, "other@example.test"), bindings))?.json()).toMatchObject({ versions: [{ version: 1 }] });
    expect((await handleSkills(request(`/${created.id}`, "PATCH", { ...content("Hijack", "No"), expectedVersion: 1 }, "other@example.test"), bindings))?.status).toBe(404);
    expect((await handleSkills(request(`/${created.id}/disable`, "POST", {}, "other@example.test"), bindings))?.status).toBe(404);
  });

  it("derives owner and org from the authenticated principal, and refuses cross-org access", async () => {
    const bindings = env();
    authState.dashboard = false;
    authState.principal = { principal: "key-owner", orgId: "org-a", scopes: ["api:read", "api:write"] };
    const createdResponse = await handleSkills(request("", "POST", content("Org skill", "Keep it scoped.")), bindings);
    expect(createdResponse?.status).toBe(201);
    const created = (await createdResponse!.json() as { skill: { id: string; owned: boolean } }).skill;
    expect(created.owned).toBe(true);

    authState.principal = { principal: "key-other", orgId: "org-b", scopes: ["api:read", "api:write"] };
    expect((await handleSkills(request(`/${created.id}`), bindings))?.status).toBe(404);
    expect((await handleSkills(request(`/${created.id}`, "DELETE"), bindings))?.status).toBe(404);
  });

  it("disables a skill so discovery and future pin resolution cannot select it", async () => {
    const bindings = env();
    const createdResponse = await handleSkills(request("", "POST", content("Revocable", "Only while active.")), bindings);
    const created = (await createdResponse!.json() as { skill: { id: string } }).skill;
    await handleSkills(request(`/${created.id}/review`, "POST", { version: 1, reviewedInstructions: "Only while active." }), bindings);
    await handleSkills(request(`/${created.id}/activate`, "POST", { version: 1, reviewedInstructions: "Only while active." }), bindings);
    expect(await resolveSkillPins(bindings, "self-hosted", "owner@example.test", [{ skillId: created.id, version: 1 }])).not.toBeNull();
    const disabled = await handleSkills(request(`/${created.id}`, "DELETE"), bindings);
    expect(await disabled?.json()).toMatchObject({ skill: { status: "disabled" } });
    expect(await resolveSkillPins(bindings, "self-hosted", "owner@example.test", [{ skillId: created.id, version: 1 }])).toBeNull();
    expect(await (await handleSkills(request(""), bindings))?.json()).toMatchObject({ skills: [{ status: "disabled" }] });
  });

  it("bounds progressive list loading and checks write permission", async () => {
    const bindings = env();
    for (let i = 0; i < 3; i++) await handleSkills(request("", "POST", content(`Skill ${i}`, `Text ${i}`)), bindings);
    const first = await handleSkills(request("?limit=2"), bindings);
    const page = await first?.json() as { skills: Array<{ id: string }>; nextCursor?: string };
    expect(page.skills).toHaveLength(2);
    expect(page.nextCursor).toBe("2");
    const second = await handleSkills(request(`?limit=2&cursor=${page.nextCursor}`), bindings);
    expect((await second?.json() as { skills: unknown[] }).skills).toHaveLength(1);
    expect((await handleSkills(request("?limit=51"), bindings))?.status).toBe(400);

    authState.dashboard = false;
    authState.principal = { principal: "read-only", orgId: "self-hosted", scopes: ["api:read"] };
    expect((await handleSkills(request("", "POST", content("Denied", "No")), bindings))?.status).toBe(403);
  });

  it("rejects arbitrary non-HTTPS provenance and invalid review routes", async () => {
    const bindings = env();
    expect((await handleSkills(request("", "POST", { ...content("Bad", "Text"), sourceUrl: "javascript:alert(1)" }), bindings))?.status).toBe(400);
    const created = await handleSkills(request("", "POST", content("Valid", "Review text")), bindings);
    const id = String((await created?.json() as { skill: { id: string } }).skill.id);
    expect((await handleSkills(request(`/${id}/activate`, "GET"), bindings))?.status).toBe(405);
  });
});
