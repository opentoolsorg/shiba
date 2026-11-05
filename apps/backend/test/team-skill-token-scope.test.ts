import { afterEach, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import type { V1Principal } from "../src/v1-auth.js";
import type { TokenRecord } from "../src/agent-tokens.js";
import { handleSkills } from "../src/skills-routes.js";
import { handleSkillLibrary } from "../src/skill-library-routes.js";
import { handleFounderSkills } from "../src/founder-skills-routes.js";
import { handleV1 } from "../src/v1-routes.js";
import { createToolRegistry } from "../src/mcp-gateway.js";
import { registerExtensionSkillMcpTools } from "../src/extension-skills-tools.js";
import { createTeamWorkspace } from "../src/team-workspaces-store.js";
import { createExtensionSkill } from "../src/extension-skills-store.js";
import { createSkill, reviewSkill, activateSkill } from "../src/skills-store.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const state = vi.hoisted(() => ({ principal: null as V1Principal | null }));
vi.mock("../src/request-auth.js", async (original) => ({ ...await original<typeof import("../src/request-auth.js")>(), isAuthorizedRequest: async () => false }));
vi.mock("../src/v1-auth.js", async (original) => ({ ...await original<typeof import("../src/v1-auth.js")>(), authorizeV1Request: async () => state.principal }));
afterEach(() => { state.principal = null; });

it("rejects reserved team scopes through API-key reads and sibling MCP tools without a current workspace grant", async () => {
  const env = { AGENT_AUDIT: customAgentD1().database } as Env, owner = "owner@example.test";
  const workspace = await createTeamWorkspace(env, owner, { name: "Native team" }), orgId = `team:${workspace.workspaceId}`;
  const teamGrant = { workspaceId: workspace.workspaceId, userId: owner, role: "owner" as const, version: workspace.membership.version };
  const skill = await createSkill(env, orgId, owner, { name: "Team instructions", instructions: "TEAM_PRIVATE_INSTRUCTIONS" }, Date.now(), { teamGrant });
  await reviewSkill(env, orgId, owner, skill.id, 1, skill.content.instructions, Date.now(), { teamGrant });
  await activateSkill(env, orgId, owner, skill.id, 1, skill.content.instructions, Date.now(), { teamGrant });
  const extensionId = await createExtensionSkill(env, orgId, owner, { name: "Team extension", description: "Shared", instructions: "TEAM_PRIVATE_INSTRUCTIONS", workspaceId: orgId, scope: "workspace", enabled: true }, Date.now(), { teamGrant });
  const token: TokenRecord = { principal: owner, orgId, kind: "api_key", scopes: ["api:read", "api:write", "integrations:read"], created: 1, revoked: false };
  state.principal = { principal: owner, orgId, scopes: ["api:read", "api:write"], apiKey: token };
  const request = (path: string) => new Request(`https://shiba.test${path}`, { headers: { Authorization: "Bearer fixture-key" } });
  for (const [handler, path] of [
    [handleSkills, "/api/skills"], [handleSkills, `/api/skills/${skill.id}`], [handleSkills, `/api/skills/${skill.id}/versions`],
    [handleSkillLibrary, "/api/skills/library"], [handleFounderSkills, "/api/founder-skills"],
    [handleV1, "/api/v1/extensions/skills"], [handleV1, `/api/v1/extensions/skills/${extensionId}/instructions`],
  ] as const) {
    const response = await handler(request(path), env);
    expect(response?.status).toBe(403); expect(await response!.text()).not.toContain("TEAM_PRIVATE_INSTRUCTIONS");
  }
  const registry = createToolRegistry(env); registerExtensionSkillMcpTools(registry, env);
  for (const [name, args] of [["list_skills", {}], ["get_skill_instructions", { skillId: extensionId }]] as const) {
    const response = await registry.invoke(name, args, token);
    expect(response.isError).toBe(true); expect(JSON.stringify(response)).not.toContain("TEAM_PRIVATE_INSTRUCTIONS");
  }
  state.principal = { principal: owner, scopes: ["api:read", "api:write"], orgId: "regular-api-org", apiKey: { ...token, orgId: "regular-api-org" } };
  expect((await handleSkills(request("/api/skills"), env))?.status).toBe(200);
  expect((await handleV1(request("/api/v1/extensions/skills"), env))?.status).toBe(200);
  expect((await registry.invoke("list_skills", {}, { ...token, orgId: "regular-api-org" })).isError).not.toBe(true);
});
