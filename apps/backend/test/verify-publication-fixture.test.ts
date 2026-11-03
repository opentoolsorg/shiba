import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

async function exercise(change = "valid") {
  const dir = mkdtempSync(join(tmpdir(), "shiba-publication-fixture-"));
  const decisions: unknown[] = [];
  let reads = 0;
  const run = { runId: "agent-tool:a1", status: "completed", publishPullRequest: true,
    repoUrl: "https://github.com/cloudflare/ai-chat", baseBranch: "main", sandboxId: "fixture-run",
    ...(change === "already-published" ? { pullUrl: "https://github.com/mock/repo/pull/1" } : {}) };
  const approval = { kind: "pr_publish", status: "pending", approvalId: "pr-publish:agent-tool:a1", threadKey: "default",
    repoUrl: run.repoUrl, baseBranch: "main", payload: { runId: run.runId, repoUrl: run.repoUrl,
      baseBranch: "main", sandboxId: run.sandboxId, baseRevision: "a".repeat(40), sha256: "b".repeat(64) } };
  if (change === "repo") approval.payload.repoUrl = "https://github.com/other/repo";
  if (change === "sandbox") approval.payload.sandboxId = "another-run";
  if (change === "base") approval.payload.baseRevision = "unverified";
  if (change === "digest") approval.payload.sha256 = "unverified";
  if (change === "status") approval.status = "approved";
  if (change === "id") approval.approvalId = "other-approval";
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "POST") {
      let body = ""; for await (const chunk of request) body += String(chunk);
      decisions.push(JSON.parse(body));
      response.end(JSON.stringify({ result: change === "decision-refused" ? "unknown" : "approved" }));
    } else {
      reads++;
      response.end(JSON.stringify(request.url?.includes("/api/runs/") ? { run } : { approvals: [approval] }));
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  for (const [file, content] of Object.entries({ port: String(port), "github-mode": change === "live" ? "live" : "mock",
    "containers-mode": change === "containers" ? "enabled" : "disabled", "standin-mode": change === "standin" ? "disabled" : "enabled" })) {
    writeFileSync(join(dir, file), content);
  }
  const moduleUrl = pathToFileURL(resolve(import.meta.dirname, "../../../.cursor/skills/verify-shiba/scripts/journey-lib.mjs")).href;
  try {
    const child = spawn(process.execPath, ["--input-type=module", "-e",
      `import { approveMockPublication } from ${JSON.stringify(moduleUrl)}; try { await approveMockPublication(${port}, 'agent-tool:a1'); } catch { process.exitCode = 1; }`],
    { env: { PATH: process.env.PATH, VERIFY_DIR: dir }, stdio: "ignore" });
    const code = await new Promise<number | null>((done, reject) => { child.once("error", reject); child.once("close", done); });
    return { code, decisions, reads };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("separate mock publication decision", () => {
  it("approves only the exact pending action after completed coding and before publication", async () => {
    expect(await exercise()).toMatchObject({ code: 0, decisions: [{ threadKey: "default", approvalId: "pr-publish:agent-tool:a1", approved: true }] });
  });
  it.each(["live", "containers", "standin"])("refuses %s mode before reading or deciding any action", async (mode) => {
    expect(await exercise(mode)).toEqual({ code: 1, reads: 0, decisions: [] });
  });
  it.each(["repo", "sandbox", "base", "digest", "status", "id", "already-published"])("rejects %s mismatch with no decision", async (change) => {
    const result = await exercise(change);
    expect(result.code).toBe(1);
    expect(result.decisions).toEqual([]);
  });
  it("does not call an unaccepted decision successful", async () => {
    const result = await exercise("decision-refused");
    expect(result.code).toBe(1);
    expect(result.decisions).toHaveLength(1);
  });
});
