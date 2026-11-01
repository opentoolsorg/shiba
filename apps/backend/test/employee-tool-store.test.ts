import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { asEmployeeActionApproval, decideEmployeeActionApproval, findEmployeeActionApproval,
  replaceEmployeeToolGrants, requestEmployeeActionApproval, resolveEmployeeConnectionGrant,
  resolveEmployeeToolPolicy, listEmployeeActionApprovals } from "../src/employee-tool-store.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

function env(): Env {
  return { AGENT_AUDIT: customAgentD1().database } as unknown as Env;
}

function legacyApprovals() {
  const { database, sqlite } = customAgentD1();
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

function interceptDatabase(database: D1Database, hooks: {
  run?: (sql: string, execute: () => Promise<D1Result>) => Promise<D1Result>;
  all?: (sql: string, execute: () => Promise<D1Result>) => Promise<D1Result>;
}): D1Database {
  return { ...database, prepare(sql: string) {
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement => ({
      bind: (...values: unknown[]) => wrap(statement.bind(...values)),
      run: () => hooks.run ? hooks.run(sql, () => statement.run()) : statement.run(),
      all: () => hooks.all ? hooks.all(sql, () => statement.all()) : statement.all(),
      first: (...args: Parameters<D1PreparedStatement["first"]>) => statement.first(...args),
    }) as D1PreparedStatement;
    return wrap(database.prepare(sql));
  } } as D1Database;
}

describe("persistent employee tool grants and exact approvals", () => {
  it.each(["alter", "index"])("keeps approval uniqueness through two cold initializers paused at %s", async (phase) => {
    const f = legacyApprovals();
    if (phase === "index") f.sqlite.exec(`ALTER TABLE employee_tool_approvals ADD COLUMN execution_context_id TEXT;
      ALTER TABLE employee_tool_approvals ADD COLUMN consumed_at INTEGER;
      ALTER TABLE employee_tool_approvals ADD COLUMN consumed_invocation_id TEXT`);
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reached = () => {};
    const held = new Promise<void>((resolve) => { reached = resolve; });
    let snapshotCount = 0;
    let bothSnapshots = () => {};
    const snapshots = new Promise<void>((resolve) => { bothSnapshots = resolve; });
    let paused = false;
    const hooks = {
      all: async (sql: string, execute: () => Promise<D1Result>) => {
        const result = await execute();
        if (sql.includes("PRAGMA table_info(employee_tool_approvals)")) {
          if (++snapshotCount === 2) bothSnapshots();
          await snapshots;
        }
        return result;
      },
      run: async (sql: string, execute: () => Promise<D1Result>) => {
        if (phase === "index" && /CREATE UNIQUE INDEX/.test(sql)) { reached(); await gate; }
        const result = await execute();
        if (phase === "alter" && !paused && /ADD COLUMN execution_context_id/.test(sql)) {
          paused = true; reached(); await gate;
        }
        return result;
      },
    };
    const first = listEmployeeActionApprovals({ AGENT_AUDIT: interceptDatabase(f.database, hooks) }, { orgId: "org-a" });
    const second = listEmployeeActionApprovals({ AGENT_AUDIT: interceptDatabase(f.database, hooks) }, { orgId: "org-a" });
    const settled = Promise.allSettled([first, second]);
    try {
      await held;
      expect(() => f.insert("duplicate-during-migration")).toThrow(/UNIQUE constraint failed/);
    } finally { release(); }
    expect((await settled).map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(() => f.insert("duplicate-after-migration")).toThrow(/UNIQUE constraint failed/);
    expect(f.sqlite.prepare("SELECT COUNT(*) AS count FROM employee_tool_approvals").get()).toEqual({ count: 1 });
    const indexes = f.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'employee_tool_approval_active_payload%'").all();
    expect(indexes).toEqual([{ name: "employee_tool_approval_active_payload_v2" }]);
    f.sqlite.close();
  });

  it("propagates unrelated ALTER failures instead of claiming initialization succeeded", async () => {
    const f = legacyApprovals();
    const db = interceptDatabase(f.database, { run: async (sql, execute) => {
      if (sql.includes("ALTER TABLE employee_tool_approvals")) throw new Error("D1 storage unavailable");
      return execute();
    } });
    await expect(listEmployeeActionApprovals({ AGENT_AUDIT: db }, { orgId: "org-a" })).rejects.toThrow("D1 storage unavailable");
    expect(() => f.insert("duplicate-after-failure")).toThrow(/UNIQUE constraint failed/);
    f.sqlite.close();
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
