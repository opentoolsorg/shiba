import { describe, expect, it, vi } from "vitest";
import { createTeamWorkspace } from "../src/team-workspaces-store.js";
import { audit, initAudit } from "../src/audit.js";
import { createWorkspaceAuditExport } from "../src/governance/audit-export-store.js";
import { governanceD1Fixture } from "./fixtures/governance-d1.js";

const alice = "alice@example.test";

describe("audit export", () => {
  it("writes NDJSON to R2 and records export metadata", async () => {
    const { env } = await governanceD1Fixture();
    const put = vi.fn(async () => ({}));
    const get = vi.fn(async () => ({ body: new ReadableStream(), httpMetadata: {} }));
    (env as { ARTIFACTS: R2Bucket }).ARTIFACTS = { put, get } as unknown as R2Bucket;
    const workspace = await createTeamWorkspace(env, alice, { name: "Audit" }, 1);
    await initAudit(env);
    await audit(env, { principal: workspace.workspaceId, tool: "test.tool", argsHash: "a".repeat(64), outcome: "ok" });
    const created = await createWorkspaceAuditExport(env, workspace.workspaceId, alice, 100);
    expect(created.rowCount).toBeGreaterThan(0);
    expect(put).toHaveBeenCalled();
    expect(created.downloadPath).toContain(created.exportId);
  });
});