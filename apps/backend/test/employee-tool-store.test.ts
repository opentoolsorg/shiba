import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { asEmployeeActionApproval, decideEmployeeActionApproval, findEmployeeActionApproval,
  replaceEmployeeToolGrants, requestEmployeeActionApproval, resolveEmployeeConnectionGrant,
  resolveEmployeeToolPolicy, listEmployeeActionApprovals } from "../src/employee-tool-store.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { applyAllMigrations } from "./fixtures/all-migrations.js";

function env(): Env {
  return { AGENT_AUDIT: customAgentD1().database } as unknown as Env;
}

function legacyApprovals() {
  const { database, sqlite } = customAgentD1({ bare: true });
  applyAllMigrations(sqlite, 60);
  sqlite.exec(`CREATE TABLE employee_tool_approvals (
    approval_id TEXT PRIMARY KEY,org_id TEXT,employee_id TEXT,employee_version INTEGER,actor_id TEXT,
    connection_id TEXT,connection_generation INTEGER,capability_kind TEXT,capability_id TEXT,action TEXT,
    resource_id TEXT,account_id TEXT,argument_digest TEXT,payload_json TEXT,policy_version TEXT,status TEXT,
    created_at INTEGER,expires_at INTEGER,decided_by TEXT,decided_at INTEGER
  ); CREATE UNIQUE INDEX employee_tool_approval_active_payload ON employee_tool_approvals
    (org_id,employee_id,employee_version,actor_id,capability_id,action,argument_digest,IFNULL(resource_id,''),connection_generation)
    WHERE status IN ('pending','approved')`);
  const insert = (id: string) => sqlite.prepare(`INSERT INTO employee_tool_approvals
    (approval_id,org_id,employee_id,employee_version,actor_id,connection_id,connection_generation,capability_kind,
     capability_id,action,resource_id,account_id,argument_digest,payload_json,policy_version,status,created_at,expires_at)
    VALUES (?,'org-a','employee-a',1,'actor-a','connection-a',1,'mcp','mcp:shiba:send_email','send_email',
      'mailbox-a','account-a','digest','{}','policy','pending',1,9999999999999)`).run(id);
  insert("original");
  return { database, sqlite, insert };
}

describe("persistent employee tool grants and exact approvals", () => {
  it.each([false, true])("preserves approval payloads and uniqueness when context columns already exist: %s", (hasContext) => {
    const f = legacyApprovals();
    try {
      if (hasContext) {
        f.sqlite.exec(`ALTER TABLE employee_tool_approvals ADD COLUMN execution_context_id TEXT;
          ALTER TABLE employee_tool_approvals ADD COLUMN consumed_at INTEGER;
          ALTER TABLE employee_tool_approvals ADD COLUMN consumed_invocation_id TEXT;
          ALTER TABLE employee_tool_approvals ADD COLUMN employee_context_json TEXT;
          ALTER TABLE employee_tool_approvals ADD COLUMN decision_owner_account_id TEXT;
          UPDATE employee_tool_approvals SET execution_context_id='context-a',employee_context_json='{"employeeId":"employee-a"}',
            decision_owner_account_id='decision-owner',consumed_at=10,consumed_invocation_id='invocation-a'`);
      }
      expect(() => f.insert("duplicate-before-migration")).toThrow(/UNIQUE constraint failed/);
      applyAllMigrations(f.sqlite);
      expect(f.sqlite.prepare("SELECT approval_id,payload_json,execution_context_id,employee_context_json,decision_owner_account_id,consumed_at,consumed_invocation_id FROM employee_tool_approvals").get())
        .toEqual({ approval_id: "original", payload_json: "{}", execution_context_id: hasContext ? "context-a" : null,
          employee_context_json: hasContext ? '{"employeeId":"employee-a"}' : null,
          decision_owner_account_id: hasContext ? "decision-owner" : null,
          consumed_at: hasContext ? 10 : null, consumed_invocation_id: hasContext ? "invocation-a" : null });
      // Reusing the identical payload in the same execution context stays fenced.
      expect(() => f.sqlite.prepare(`INSERT INTO employee_tool_approvals (
        employee_context_json,decision_owner_account_id,approval_id,org_id,employee_id,employee_version,actor_id,
        execution_context_id,consumed_at,consumed_invocation_id,connection_id,connection_generation,capability_kind,
        capability_id,action,resource_id,account_id,argument_digest,payload_json,policy_version,status,created_at,expires_at,decided_by,decided_at)
        SELECT employee_context_json,decision_owner_account_id,'duplicate',org_id,employee_id,employee_version,actor_id,
          execution_context_id,consumed_at,consumed_invocation_id,connection_id,connection_generation,capability_kind,
          capability_id,action,resource_id,account_id,argument_digest,payload_json,policy_version,status,created_at,expires_at,decided_by,decided_at
        FROM employee_tool_approvals`).run()).toThrow(/UNIQUE constraint failed/);
      expect(f.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'employee_tool_approval_active_payload%'").all())
        .toEqual([{ name: "employee_tool_approval_active_payload_v2" }]);
    } finally { f.sqlite.close(); }
  });

  it("fails on an uninstalled schema without creating tables during a read", async () => {
    const { database, sqlite } = customAgentD1({ bare: true });
    try {
      await expect(listEmployeeActionApprovals({ AGENT_AUDIT: database }, { orgId: "org-a" }))
        .rejects.toThrow(/no such table/);
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([]);
    } finally { sqlite.close(); }
  });

  it("persists selected provider resources with their authenticated connection and account", async () => {
    const bindings = env();
    await replaceEmployeeToolGrants(bindings, {
      orgId: "org-a", employeeId: "employee-gmail", employeeVersion: 2, actorId: "agent-a", role: "member",
      capabilityIds: ["mcp:shiba:gmail_read"], resourcesByCapability: { "mcp:shiba:gmail_read": ["msg_1"] },
      resourceConnectionsByCapability: { "mcp:shiba:gmail_read": { msg_1: "gmail-connection-1" } },
      resourceAccountsByCapability: { "mcp:shiba:gmail_read": { msg_1: "owner-account" } }, now: 100,
    });
    const grant = await resolveEmployeeConnectionGrant(bindings, {
      orgId: "org-a", employeeId: "employee-gmail", employeeVersion: 2, actorId: "agent-a",
      capabilityId: "mcp:shiba:gmail_read", resourceId: "msg_1",
    });
    expect(grant).toMatchObject({ connectionId: "gmail-connection-1", accountId: "owner-account", allowedResources: ["msg_1"] });
  });

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
