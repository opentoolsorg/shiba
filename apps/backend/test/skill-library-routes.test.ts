import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { handleSkillLibrary } from "../src/skill-library-routes.js";
import { handleSkills } from "../src/skills-routes.js";
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
