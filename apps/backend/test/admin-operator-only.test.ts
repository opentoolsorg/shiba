import { describe, expect, it, vi } from "vitest";
import { handleGovernance } from "../src/governance-routes.js";
import { governanceD1Fixture } from "./fixtures/governance-d1.js";
import type { Env } from "../src/env.js";

vi.mock("../src/request-auth.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/request-auth.js")>(),
  isAuthorizedRequest: vi.fn(async () => true),
  resolveUserId: vi.fn(async () => "alice@example.test"),
}));

vi.mock("../src/team-member-auth.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/team-member-auth.js")>(),
  isTeamDeploymentOperator: vi.fn(async () => false),
}));

describe("admin operator gate", () => {
  it("rejects non-operators for admin console routes", async () => {
    const { env } = await governanceD1Fixture();
    const response = await handleGovernance(
      new Request("https://worker.test/api/governance/admin/workspaces"),
      env as Env,
    );
    expect(response?.status).toBe(403);
  });
});