import { expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { assertSandboxArtifactAccess } from "../src/artifact-access.js";

vi.mock("../src/request-auth.js", () => ({
  isAuthorizedRequest: async () => true,
  resolveUserId: async () => "attacker@example.test",
}));

it("does not accept a spoofed Access header as shared-artifact approver identity", async () => {
  const response = await assertSandboxArtifactAccess(new Request("https://dashboard/artifact", {
    headers: { "CF-Access-Authenticated-User-Email": "owner@example.test" },
  }), { DASHBOARD_APPROVERS: "owner@example.test" } as Env, "shared-sandbox", "default");
  expect(response?.status).toBe(404);
});
