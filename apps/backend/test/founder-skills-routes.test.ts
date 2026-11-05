import { beforeEach, describe, expect, it, vi } from "vitest";
import { validateEmployeeBundle } from "@shiba/shared";
import type { Env } from "../src/env.js";
import { handleFounderSkills } from "../src/founder-skills-routes.js";
import { handleEmployeeBundles } from "../src/employee-bundles-routes.js";
import { getCustomAgentById } from "../src/custom-agents-store.js";
import { activateSkill, disableSkill, getSkill, reviewSkill } from "../src/skills-store.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const auth = vi.hoisted(() => ({ orgId: "self-hosted", owner: "owner@example.test" }));
vi.mock("../src/org-request-auth.js", () => ({ resolveOrgForApiRequest: vi.fn(async () => ({ orgId: auth.orgId, principal: null })) }));
vi.mock("../src/request-auth.js", () => ({ resolveUserId: vi.fn(async () => auth.owner) }));

const id = "founder-stripe-revenue-pulse";
const request = (suffix: string, method = "GET") => new Request(`https://shiba.test/api/founder-skills${suffix}`, { method });
const bundleRequest = (action: string, body: unknown) => new Request(`https://shiba.test/api/employee-bundles/${action}`, {
  method: "POST", headers: { Origin: "https://shiba.test", "Content-Type": "application/json" }, body: JSON.stringify(body),
});
function fixture() {
  const db = customAgentD1();
  const env = { AGENT_AUDIT: db.database } as Env;
  for (const name of ["CodingOrchestrator", "Sandbox", "GITHUB_TOKEN", "OPENCONNECTOR_ADMIN_KEY", "SLACK_BOT_TOKEN"])
    Object.defineProperty(env, name, { get: () => { throw new Error(`Setup must not access ${name}`); } });
  return { ...db, env };
}
beforeEach(() => { auth.orgId = "self-hosted"; auth.owner = "owner@example.test"; });

describe("founder skill drafts", () => {
  it("preserves draft installation and distinguishes unavailable execution from supported private review scheduling", async () => {
    const { env } = fixture();
    const installed = await handleFounderSkills(request(`/${id}/install`, "POST"), env);
    expect(installed?.status).toBe(201);
    expect(await installed?.json()).toMatchObject({ skill: { status: "draft", libraryId: id } });
    const deployed = await handleFounderSkills(request(`/${id}/deploy`, "POST"), env);
    expect(deployed?.status).toBe(501);
    expect(await deployed?.json()).toMatchObject({ error: "scheduled_connector_execution_unavailable", setupPath: `/api/founder-skills/${id}/setup`, setupState: "manual_review_required", reviewDraftPath: `/api/founder-skills/${id}/review-schedule` });
  });

  it("converges concurrent install retries on one tracked draft and separates owners and orgs", async () => {
    const { env, sqlite } = fixture();
    const responses = await Promise.all(Array.from({ length: 6 }, () => handleFounderSkills(request(`/${id}/install`, "POST"), env)));
    const bodies = await Promise.all(responses.map((response) => response!.json())) as Array<{ skill: { id: string } }>;
    expect(new Set(bodies.map((body) => body.skill.id)).size).toBe(1);
    expect(responses.filter((response) => response?.status === 201)).toHaveLength(1);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM skills WHERE status <> 'disabled'").get()).toEqual({ n: 1 });
    const catalog = await handleFounderSkills(request(""), env);
    expect(catalog?.headers.get("cache-control")).toBe("no-store");
    expect(await catalog?.json()).toMatchObject({ skills: expect.arrayContaining([expect.objectContaining({ id, installed: true, installedStatus: "draft" })]) });
    auth.owner = "other@example.test";
    const otherCatalog = await handleFounderSkills(request(""), env);
    expect(await otherCatalog?.json()).toMatchObject({ skills: expect.arrayContaining([expect.objectContaining({ id, installed: false })]) });
    const other = await handleFounderSkills(request(`/${id}/install`, "POST"), env);
    expect((await other?.json() as { skill: { id: string } }).skill.id).not.toBe(bodies[0]!.skill.id);
    auth.orgId = "another-org";
    const separate = await handleFounderSkills(request(""), env);
    expect(await separate?.json()).toMatchObject({ skills: expect.arrayContaining([expect.objectContaining({ id, installed: false })]) });
  });

  it("preserves active versions on retry and allows reinstalling a disabled draft", async () => {
    const { env } = fixture();
    const response = await handleFounderSkills(request(`/${id}/install`, "POST"), env);
    const installed = await response!.json() as { skill: { id: string } };
    const skill = await getSkill(env, auth.orgId, auth.owner, installed.skill.id);
    if (!skill) throw new Error("Missing founder draft");
    await reviewSkill(env, auth.orgId, auth.owner, skill.id, 1, skill.content.instructions);
    await activateSkill(env, auth.orgId, auth.owner, skill.id, 1, skill.content.instructions);
    const retried = await handleFounderSkills(request(`/${id}/install`, "POST"), env);
    expect(retried?.status).toBe(200);
    expect(await retried?.json()).toMatchObject({ skill: { id: skill.id, status: "active", version: 1 } });
    await disableSkill(env, auth.orgId, auth.owner, skill.id);
    expect(await (await handleFounderSkills(request(""), env))?.json()).toMatchObject({ skills: expect.arrayContaining([expect.objectContaining({ id, installed: false })]) });
    const replaced = await handleFounderSkills(request(`/${id}/install`, "POST"), env);
    expect(replaced?.status).toBe(201);
    expect((await replaced?.json() as { skill: { id: string; status: string } }).skill).toMatchObject({ status: "draft", id: expect.not.stringMatching(`^${skill.id}$`) });
  });

  it("prepares setup without writes, then imports only a digest-reviewed archived profile and draft instructions", async () => {
    const { env, sqlite } = fixture();
    const prepared = await handleFounderSkills(request(`/${id}/setup`), env);
    expect(prepared?.status).toBe(200);
    const body = await prepared!.json() as { recipe: unknown };
    const recipe = validateEmployeeBundle(body.recipe);
    expect(recipe.profile.expectedDeliverables).toEqual(["reports/stripe-revenue-pulse.md"]);
    expect(recipe.requirements).toMatchObject([{ name: "stripe", kind: "app" }]);
    expect(recipe.routines.every((routine) => routine.enabled === false)).toBe(true);
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([]);
    const previewResponse = await handleEmployeeBundles(bundleRequest("preview", { recipe }), env);
    expect(previewResponse?.status).toBe(200);
    const preview = await previewResponse!.json() as { previewId: string; digest: string };
    const input = { previewId: preview.previewId, expectedDigest: preview.digest, importId: "founder-setup-test", recipe, reviewed: true };
    const wrongBytes = await handleEmployeeBundles(bundleRequest("import", { ...input, recipe: { ...recipe, profile: { ...recipe.profile, instructions: "Changed after review" } } }), env);
    expect(wrongBytes?.status).toBe(409);
    const imported = await handleEmployeeBundles(bundleRequest("import", input), env);
    expect(imported?.status).toBe(201);
    const result = await imported!.json() as { employeeId: string; skillIds: string[] };
    expect(await getCustomAgentById(env, auth.orgId, result.employeeId)).toBeNull();
    const employee = await getCustomAgentById(env, auth.orgId, result.employeeId, { includeArchived: true });
    expect(employee?.archivedAt).toBeTypeOf("number");
    expect(employee?.config.expectedDeliverables).toEqual(recipe.profile.expectedDeliverables);
    expect(employee?.config.toolScopes).toBeUndefined();
    expect(await getSkill(env, auth.orgId, auth.owner, result.skillIds[0]!)).toMatchObject({ status: "draft", version: 1 });
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE name IN ('employee_tool_grants','external_mcp_servers','automations')").all()).toEqual([]);
    expect(await (await handleEmployeeBundles(bundleRequest("import", input), env))?.json()).toMatchObject(result);
    auth.owner = "other@example.test";
    expect((await handleEmployeeBundles(bundleRequest("import", { ...input, importId: "foreign-founder-setup" }), env))?.status).toBe(409);
  });

  it("rejects malformed ids rather than throwing and keeps setup read-only", async () => {
    const { env } = fixture();
    expect((await handleFounderSkills(request("/%E0%A4%A/setup"), env))?.status).toBe(400);
    expect((await handleFounderSkills(request(`/${id}/setup`, "POST"), env))?.status).toBe(405);
    expect((await handleFounderSkills(request("/unknown/setup"), env))?.status).toBe(404);
  });
});
