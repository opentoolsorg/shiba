/** Exercise the existing no-secret local Worker without intercepting its APIs.
 * SHIBA_UX_ORIGIN must point at a frontend proxying a loopback-only Worker.
 * --standin-unconfigured uses the documented loopback stand-in and verifies
 * its unconfigured human approver is denied. It never changes access settings.
 * --owned-standin creates a normal named thread and uses its existing owner
 * decision path; missing signing configuration remains a recorded blocker.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.SHIBA_PLAYWRIGHT_MODULE || "../.cursor/skills/verify-shiba/node_modules/playwright");
const origin = process.env.SHIBA_UX_ORIGIN || "http://127.0.0.1:5173";
assert(["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname), "Requires a loopback frontend and Worker");
const standin = process.argv.includes("--standin-unconfigured");
const ownedStandin = process.argv.includes("--owned-standin");
const output = path.resolve(process.env.SHIBA_UX_OUTPUT || ".verify/ux-local-backend");
await mkdir(output, { recursive: true });
const report = { sha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), trackedChanges: execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim(), apiMocks: false, liveProviderE2E: false, standin: standin || ownedStandin, ownedStandin, boundary: "Real local Worker APIs and storage; no supplied credentials or container execution", checks: [], writes: [], pageErrors: [], externalRequests: [] };
const browser = await chromium.launch({ executablePath: process.env.SHIBA_CHROMIUM || "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.addInitScript(() => { localStorage.setItem("shiba.employee-onboarding.dismissed", "true"); sessionStorage.setItem("shiba:first-run-seed:default", "1"); });
await context.route("**/*", (route) => {
  const url = new URL(route.request().url());
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) { report.externalRequests.push(url.origin); return route.abort(); }
  return route.continue();
});
const page = await context.newPage();
page.on("pageerror", (error) => report.pageErrors.push(error.message));
const passed = (name) => report.checks.push({ name, passed: true });
try {
  const ownedReady = ownedStandin ? page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/runs" && url.searchParams.get("session") === "default" && response.ok();
  }) : null;
  await page.goto(`${origin}/threads/`);
  if (ownedStandin) {
    await ownedReady;
    const created = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/sessions" && response.request().method() === "POST");
    await page.getByRole("button", { name: "New chat", exact: true }).first().click();
    const response = await created;
    assert.equal(response.status(), 201);
    report.sessionId = (await response.json()).session.id;
    passed("Create a normal owned thread through the existing UI");
  }
  const draft = `LOCAL_UX_${Date.now()}: draft a README for human review; never publish`;
  await page.getByRole("form", { name: "Chat composer", exact: true }).locator("textarea").fill(draft);
  await page.getByRole("button", { name: "Review as work", exact: true }).click();
  const composer = page.getByRole("form", { name: "Task composer", exact: true });
  assert.equal(await composer.getByRole("textbox", { name: "Task description", exact: true }).inputValue(), draft);
  passed("Chat draft survives Work review");
  await composer.getByRole("combobox", { name: "Work target", exact: true }).selectOption("artifact-workspace");
  await composer.getByRole("textbox", { name: "Artifact deliverables", exact: true }).fill(ownedStandin ? "README.md" : "");
  const queued = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/runs" && response.request().method() === "POST");
  await composer.getByRole("button", { name: "Send task", exact: true }).click();
  const response = await queued;
  const receipt = await response.json();
  report.writes.push({ path: "/api/runs", status: response.status(), response: receipt });
  if (standin || ownedStandin) {
    assert.equal(response.status(), 200);
    report.approvalId = receipt.approvalId;
    await page.waitForURL((url) => url.pathname === "/work/" && url.searchParams.get("task") === receipt.approvalId);
    const inspector = page.getByRole("dialog", { name: `Work inspector: ${draft}`, exact: true });
    await inspector.waitFor();
    const data = await (await context.request.get(`${origin}/api/approvals`)).json();
    const record = data.approvals.find((item) => item.approvalId === receipt.approvalId);
    assert.equal(record?.status, "pending");
    report.frozen = JSON.parse(await inspector.locator("pre").innerText());
    assert.equal(report.frozen.task, record.task);
    assert.equal(report.frozen.publishPullRequest, false);
    passed("Server receipt automatically opens the persisted frozen approval");
    await page.reload();
    await inspector.waitFor();
    passed("Pending approval inspector survives reload");
    const decision = page.waitForResponse((result) => new URL(result.url()).pathname === "/api/approvals" && result.request().method() === "POST");
    await inspector.getByRole("button", { name: "Approve", exact: true }).click();
    const denied = await decision;
    report.writes.push({ path: "/api/approvals", status: denied.status(), response: await denied.json() });
    if (ownedStandin) {
      assert.equal(denied.status(), 200);
      await page.waitForURL((url) => url.searchParams.get("taskKind") === "run");
      report.runId = new URL(page.url()).searchParams.get("task");
      const query = `?session=${encodeURIComponent(report.sessionId)}`;
      for (let attempt = 0; attempt < 40; attempt++) {
        const detail = await (await context.request.get(`${origin}/api/runs/${encodeURIComponent(report.runId)}${query}`)).json();
        report.run = detail.run;
        if (report.run && ["completed", "error", "unknown", "cancelled", "aborted"].includes(report.run.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      assert.equal(report.run.approval.approvalId, receipt.approvalId);
      passed("Existing owner authorization accepts the explicit decision and opens its server-linked run");
      await page.reload();
      await inspector.waitFor();
      await inspector.getByRole("tab", { name: "Diff", exact: true }).click();
      if (report.run.status === "completed") await inspector.getByText(/verify-shiba stand-in change/).first().waitFor();
      await page.screenshot({ path: path.join(output, "owned-run-diff.png") });
      await inspector.getByRole("tab", { name: "Output", exact: true }).click();
      await page.screenshot({ path: path.join(output, "owned-run-output.png") });
      report.outputText = await inspector.getByRole("tabpanel").innerText();
      if (report.run.status === "completed") {
        assert.match(report.outputText, /stand-in/);
        await inspector.getByRole("link", { name: "Download README.md", exact: true }).waitFor();
        passed("Persisted stand-in completion restores Diff and Output after reload");
      } else {
        if (report.run.status === "error") {
          await inspector.getByText("Error", { exact: true }).first().waitFor();
          assert.match(report.outputText, /Not captured/);
          passed("Real execution error and uncaptured deliverable remain truthful after reload");
        }
        report.blocker = `Real retained run status: ${report.run.status}; ${report.run.error || "execution pending"}`;
      }
    } else {
      assert.equal(denied.status(), 403);
      const runs = await (await context.request.get(`${origin}/api/runs`)).json();
      assert(!runs.runs.some((run) => run.approval?.approvalId === receipt.approvalId));
      passed("Unconfigured human approver is refused; no run created for this approval");
      report.blocker = "Approval returns 403: no DASHBOARD_APPROVERS configured. Access settings left unchanged.";
    }
  } else {
    assert(!response.ok());
    await page.getByText(/AI Gateway is not configured/).first().waitFor();
    const approvals = await (await context.request.get(`${origin}/api/approvals`)).json();
    assert(!approvals.approvals.some((item) => item.task === draft));
    passed("Missing provider route prevents approval creation");
    report.blocker = "No configured provider, gateway token, or paired local daemon; no credentials fabricated.";
  }
  await page.screenshot({ path: path.join(output, "local-worker-boundary.png") });
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.externalRequests, []);
} catch (error) {
  report.error = String(error);
  report.checks.push({ name: "Local Worker browser flow", passed: false });
  await page.screenshot({ path: path.join(output, "failure.png") }).catch(() => {});
} finally {
  await browser.close();
  await writeFile(path.join(output, "browser.json"), `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify(report, null, 2));
if (report.error) process.exitCode = 1;
