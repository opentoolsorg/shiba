import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startWorkerFixture } from "./worker-fixture.mjs";

test("isolated Worker signs one approved local dispatch and retains its result", { timeout: 180_000 }, async () => {
  const fixture = await startWorkerFixture({ localRuntime: true });
  let cookie = "";
  async function api(route, body, bearer) {
    const response = await fetch(`${fixture.origin}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", origin: fixture.origin,
        ...(cookie ? { cookie } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
    });
    if (route.startsWith("/api/auth/")) cookie = response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    const value = await response.json();
    assert(response.ok, `${route} failed: ${response.status} ${JSON.stringify(value)}`);
    return value;
  }
  try {
    await api("/api/auth/sign-up/email", { name: "Fixture Owner", email: "native-owner@example.test", password: "fixture-dispatch-password-only-2026!" });
    const pairing = await api("/api/computers/pairing-token", {});
    const paired = await api("/api/local/pair", { pairingToken: pairing.token, hostname: "fixture-dispatch", platform: "linux-x64", daemonVersion: "0.1.0", harnesses: ["opencode"] });
    await api("/api/local/heartbeat", { machineId: paired.machineId, hostname: "fixture-dispatch", platform: "linux-x64", daemonVersion: "0.1.0", harnesses: ["opencode"] }, paired.adapterToken);
    const task = "Use supplied fixture facts only. No external calls are permitted.";
    const queued = await api("/api/runs", { repoUrl: "https://github.com/opentoolsorg/shiba", task, publishPullRequest: false,
      runtime: "local", harness: "opencode", targetMachineId: paired.machineId });
    const pointers = await api("/api/approvals");
    const approval = pointers.approvals.find((item) => item.approvalId === queued.approvalId);
    assert(approval, "Pending approval exists");
    assert(!(await api("/api/local/claim", { operator: "fixture-dispatch" }, paired.adapterToken)).envelope, "No claim before fixture owner approval");
    assert.equal((await api("/api/approvals", { approvalId: approval.approvalId, threadKey: approval.threadKey, approved: true })).result, "approved");
    const runId = `agent-tool:${approval.approvalId}`;
    let claim;
    const claimDeadline = Date.now() + 15_000;
    do {
      claim = await api("/api/local/claim", { operator: "fixture-dispatch" }, paired.adapterToken);
      const run = (await api("/api/runs")).runs.find((item) => item.runId === runId);
      assert(!run || !["error", "unknown", "aborted"].includes(run.status), `Dispatch failed: ${run?.error ?? run?.status}`);
      if (claim.envelope) break;
      await delay(100);
    } while (Date.now() < claimDeadline);
    assert(claim.envelope, "Approved dispatch reaches the paired adapter");
    assert.equal(claim.envelope.task, task);
    const signingKey = JSON.parse(await readFile(`${fixture.tempRoot}/wrangler.json`, "utf8")).vars.INTERNAL_SIGNING_KEY;
    assert(typeof signingKey === "string" && /^[a-f0-9]{64}$/.test(signingKey), "The isolated Worker has a synthetic signing identity");
    assert(!JSON.stringify(claim.envelope).includes(signingKey), "Worker signing identity stays outside the adapter envelope");
    assert(!fixture.logs.join("").includes(signingKey), "Captured fixture logs redact signing identity");
    assert(!(await api("/api/local/claim", { operator: "fixture-dispatch" }, paired.adapterToken)).envelope, "Only one claim exists");
    await api("/api/local/result", { sandboxId: claim.envelope.sandboxId, claimToken: claim.claimToken, result: {
      status: "completed", exitCode: 0, summary: "Deterministic fixture output; no CLI or model invoked.", stdoutTail: "fixture completed",
      stderrTail: "", changedFiles: ["reports/fixture.md"],
      diff: "diff --git a/reports/fixture.md b/reports/fixture.md\nnew file mode 100644\n--- /dev/null\n+++ b/reports/fixture.md\n@@ -0,0 +1 @@\n+Supplied fixture facts only.\n",
      files: [{ path: "reports/fixture.md", encoding: "utf8", content: "Supplied fixture facts only.\n" }],
    } }, paired.adapterToken);
    let completed;
    const finishDeadline = Date.now() + 15_000;
    do {
      completed = (await api("/api/runs")).runs.find((item) => item.runId === runId);
      assert(!completed || !["error", "unknown", "aborted"].includes(completed.status), `Completion failed: ${completed?.error ?? completed?.status}`);
      if (completed?.status === "completed") break;
      await delay(100);
    } while (Date.now() < finishDeadline);
    assert.equal(completed?.status, "completed");
    assert(!(await api("/api/local/claim", { operator: "fixture-dispatch" }, paired.adapterToken)).envelope, "Completion never redispatches");
  } catch (error) {
    console.error(fixture.logs.slice(-20).join("\n"));
    throw error;
  } finally {
    await fixture.stop();
  }
});
