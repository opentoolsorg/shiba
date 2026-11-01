import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { handleFounderSkills } from "../src/founder-skills-routes.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

vi.mock("../src/org-request-auth.js", () => ({
  resolveOrgForApiRequest: vi.fn(async () => ({ orgId: "self-hosted", principal: null })),
}));
vi.mock("../src/request-auth.js", () => ({
  resolveUserId: vi.fn(async () => "owner@example.test"),
}));

const request = (suffix: string, method = "GET") => new Request(
  `https://shiba.test/api/founder-skills${suffix}`, { method },
);

describe("founder skill drafts", () => {
  it("preserves draft installation while refusing schedules without reviewed integration configuration", async () => {
    const fetch = vi.fn();
    const env = { AGENT_AUDIT: customAgentD1().database, CodingOrchestrator: { fetch } } as unknown as Env;
    const installed = await handleFounderSkills(request("/founder-stripe-revenue-pulse/install", "POST"), env);
    expect(installed?.status).toBe(201);
    expect(await installed?.json()).toMatchObject({ skill: { status: "draft", libraryId: "founder-stripe-revenue-pulse" } });
    const deployed = await handleFounderSkills(request("/founder-stripe-revenue-pulse/deploy", "POST"), env);
    expect(deployed?.status).toBe(409);
    expect(await deployed?.json()).toMatchObject({ error: "integration_schedule_configuration_required" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
