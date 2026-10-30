import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { asEmployeeActionApproval, decideEmployeeActionApproval, findEmployeeActionApproval,
  replaceEmployeeToolGrants, requestEmployeeActionApproval, resolveEmployeeConnectionGrant,
  resolveEmployeeToolPolicy } from "../src/employee-tool-store.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

function env(): Env {
  return { AGENT_AUDIT: customAgentD1().database } as unknown as Env;
}

describe("persistent employee tool grants and exact approvals", () => {
  it("resolves workspace, actor and role intersections and current resource grants", async () => {
    const bindings = env();
    await replaceEmployeeToolGrants(bindings, {
      orgId: "org-a", employeeId: "employee-a", employeeVersion: 3, actorId: "agent-a", role: "operator",
      capabilityIds: ["mcp:shiba:run_status"], resourcesByCapability: { "mcp:shiba:run_status": ["run-1"] }, now: 100,
    });
    const state = await resolveEmployeeToolPolicy(bindings, {
      orgId: "org-a", employeeId: "employee-a", employeeVersion: 3, actorId: "agent-a",
    });
    expect(state).toMatchObject({
      role: "operator", workspaceCapabilityIds: ["mcp:shiba:run_status"],
      actorCapabilityIds: ["mcp:shiba:run_status"], roleCapabilityIds: ["mcp:shiba:run_status"],
    });
    expect(await resolveEmployeeConnectionGrant(bindings, {
      orgId: "org-a", employeeId: "employee-a", employeeVersion: 3, actorId: "agent-a",
      capabilityId: "mcp:shiba:run_status", resourceId: "run-1",
    })).toMatchObject({ lifecycle: "active", verification: "configured", allowedResources: ["run-1"], generation: 1 });
    expect(await resolveEmployeeConnectionGrant(bindings, {
      orgId: "org-a", employeeId: "employee-a", employeeVersion: 3, actorId: "agent-a",
      capabilityId: "mcp:shiba:run_status", resourceId: "run-2",
    })).toBeNull();
    expect(await resolveEmployeeToolPolicy(bindings, {
      orgId: "org-b", employeeId: "employee-a", employeeVersion: 3, actorId: "agent-a",
    })).toBeNull();
    expect(await resolveEmployeeToolPolicy(bindings, {
      orgId: "org-a", employeeId: "employee-a", employeeVersion: 2, actorId: "agent-a",
    })).toBeNull();
  });

  it("persists frozen payloads and only resolves an approval for the identical payload digest and employee version", async () => {
    const bindings = env();
    const payload = { repoUrl: "https://github.com/acme/demo", task: "Inspect the build", resourceId: "repo-1" };
    const digest = "a".repeat(64);
    const pending = await requestEmployeeActionApproval(bindings, {
      orgId: "org-a", employeeId: "employee-a", employeeVersion: 3, actorId: "agent-a",
      connectionId: "connection-1", connectionGeneration: 2,
      capability: { kind: "mcp", id: "mcp:shiba:queue_run" }, action: "queue_run", resourceId: "repo-1",
      argumentDigest: digest, payload, policyVersion: "employee-policy-current", expiresAt: 2_000, now: 1_000,
    });
    expect(pending).toMatchObject({ status: "pending", payload, employeeVersion: 3 });
    const approved = await decideEmployeeActionApproval(bindings, {
      orgId: "org-a", employeeId: "employee-a", approvalId: pending.approvalId, approved: true, decidedBy: "owner", now: 1_100,
    });
    expect(approved).toMatchObject({ status: "approved", payload, decidedBy: "owner" });
    expect(asEmployeeActionApproval(approved!)).toMatchObject({ approved: true, employeeId: "employee-a", employeeVersion: 3,
      argumentDigest: digest, capability: { id: "mcp:shiba:queue_run" } });
    expect(await findEmployeeActionApproval(bindings, {
      orgId: "org-a", employeeId: "employee-a", employeeVersion: 3, actorId: "agent-a",
      capabilityId: "mcp:shiba:queue_run", action: "queue_run", argumentDigest: digest,
      resourceId: "repo-1", connectionGeneration: 2, now: 1_200,
    })).toMatchObject({ approvalId: pending.approvalId, status: "approved" });
    expect(await findEmployeeActionApproval(bindings, {
      orgId: "org-a", employeeId: "employee-a", employeeVersion: 4, actorId: "agent-a",
      capabilityId: "mcp:shiba:queue_run", action: "queue_run", argumentDigest: digest,
      resourceId: "repo-1", connectionGeneration: 2, now: 1_200,
    })).toBeNull();
    expect(await findEmployeeActionApproval(bindings, {
      orgId: "org-a", employeeId: "employee-a", employeeVersion: 3, actorId: "agent-a",
      capabilityId: "mcp:shiba:queue_run", action: "queue_run", argumentDigest: "b".repeat(64),
      resourceId: "repo-1", connectionGeneration: 2, now: 1_200,
    })).toBeNull();
  });
});
