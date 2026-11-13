/** Exercise the existing no-secret local Worker without intercepting its APIs.
 * SHIBA_UX_ORIGIN must point at a frontend proxying a loopback-only Worker.
 * --standin-unconfigured uses the documented loopback stand-in and verifies
 * its unconfigured human approver is denied. It never changes access settings.
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
const output = path.resolve(process.env.SHIBA_UX_OUTPUT || ".verify/ux-local-backend");
await mkdir(output, { recursive: true });
const report = { sha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), trackedChanges: execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim(), apiMocks: false, liveProviderE2E: false, standin, boundary: "Real local Worker APIs and storage; no supplied credentials or container execution", checks: [], writes: [], pageErrors: [], externalRequests: [] };
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
  await page.goto(`${origin}/threads/`);
  const draft = `LOCAL_UX_${Date.now()}: draft a README for human review; never publish`;
  await page.getByRole("form", { name: "Chat composer", exact: true }).locator("textarea").fill(draft);
  await page.getByRole("button", { name: "Review as work", exact: true }).click();
  const composer = page.getByRole("form", { name: "Task composer", exact: true });
  assert.equal(await composer.getByRole("textbox", { name: "Task description", exact: true }).inputValue(), draft);
  passed("Chat draft survives Work review");
  await composer.getByRole("combobox", { name: "Work target", exact: true }).selectOption("artifact-workspace");
  await composer.getByRole("textbox", { name: "Artifact deliverables", exact: true }).fill("");
  const queued = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/runs" && response.request().method() === "POST");
  await composer.getByRole("button", { name: "Send task", exact: true }).click();
  const response = await queued;
  const receipt = await response.json();
  report.writes.push({ path: "/api/runs", status: response.status(), response: receipt });
  if (standin) {
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
    assert.equal(denied.status(), 403);
    const runs = await (await context.request.get(`${origin}/api/runs`)).json();
    assert(!runs.runs.some((run) => run.approval?.approvalId === receipt.approvalId));
    passed("Unconfigured human approver is refused; no run created for this approval");
    report.blocker = "Approval returns 403: no DASHBOARD_APPROVERS configured. Access settings left unchanged.";
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
