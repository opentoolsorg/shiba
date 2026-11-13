/** Browser acceptance against a local dashboard with entirely intercepted fixture APIs.
 * Run the frontend, then SHIBA_PLAYWRIGHT_MODULE=/path/to/playwright node scripts/verify-ux-fixtures.mjs.
 * This verifies UI behavior, never provider execution or deployment routing.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.SHIBA_PLAYWRIGHT_MODULE || "../.cursor/skills/verify-shiba/node_modules/playwright");
const canonicalViews = ["work", "dashboard", "tasks", "threads", "activity", "analytics", "diff", "approvals", "swarm", "collaboration", "team", "agents", "inbox", "memory", "automations", "providers", "employee-tools", "integrations", "skills", "spaces", "custom-agents", "remote", "settings"];
let origin = process.env.SHIBA_UX_ORIGIN || "http://localhost:5173";
let staticServer;
if (process.argv.includes("--built")) {
  // Serves production bytes locally. Worker-host routing is covered separately by app-host-routing.test.ts.
  const root = path.resolve("apps/frontend/dist/client");
  staticServer = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      const pathname = decodeURIComponent(url.pathname);
      const shell = /^\/(?:app|slack-canvas)?\/?$/.test(pathname) || canonicalViews.some((view) => pathname === `/${view}/` || pathname === `/${view}`);
      const filename = shell ? path.join(root, "app/index.html") : path.resolve(root, `.${pathname}`);
      if (!filename.startsWith(`${root}${path.sep}`)) throw new Error("Outside asset root");
      const bytes = await readFile(filename);
      const types = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };
      response.writeHead(200, { "content-type": types[path.extname(filename)] || "application/octet-stream" });
      response.end(bytes);
    } catch {
      response.writeHead(404);
      response.end("Fixture asset not found");
    }
  });
  await new Promise((resolve) => staticServer.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${staticServer.address().port}`;
}
assert(["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname), "Fixture harness requires loopback");
const output = path.resolve(process.env.SHIBA_UX_OUTPUT || ".verify/ux-modernization");
await mkdir(output, { recursive: true });
const now = Date.now();
const runs = [
  ["running", "Running fixture"], ["completed", "Completed fixture"],
  ["error", "Failed fixture"], ["unknown", "Unknown fixture"],
].map(([status, task], index) => ({ runId: `ux-run-${index}`, sandboxId: `ux-sandbox-${index}`, task, status, repoUrl: "https://github.com/fixture/example", baseBranch: "main", publishPullRequest: false, generation: 1, createdAt: now - 90000, updatedAt: now - index * 1000 }));
runs.push({ ...runs[1], runId: "ux-pr", task: "PR fixture", pullUrl: "https://github.com/fixture/example/pull/1" });
const approval = { approvalId: "ux-approval", threadKey: "", task: "Frozen approval fixture", repoUrl: "https://github.com/fixture/example", kind: "run", status: "pending", createdAt: now, payload: { repoUrl: "https://github.com/fixture/example", task: "FROZEN_UX_PAYLOAD", baseBranch: "main", publishPullRequest: false } };
const empty = { workspaces: [], sessions: [], runs: [], approvals: [], decided: [], agents: [], principals: [], connections: [], computers: [], entries: [], sources: [], projects: [], spaces: [], tasks: [], items: [], members: [], providers: [], facts: [], mailboxes: [], automations: [], events: [], outbox: [], skills: [], servers: [] };
const setup = { slack: { signingSecret: false, botToken: false, approvers: 0, channelRepos: false }, github: { token: false, app: false, publish: false, webhookSecret: false }, linear: { webhookSecret: false, apiToken: false, defaultRepo: false }, slackVerification: { signingSecret: false }, gateway: { id: "", token: false, reachable: "unknown" }, access: { required: true }, betterAuth: { configured: false }, models: { orchestrator: "", coding: "", harness: "opencode", roles: [] }, automations: { enabled: false, typeSafe: false }, mailbox: { addressOverride: false, sendEnabled: false }, doctor: { ok: false, checkedAt: now, findings: [], roles: [] } };
const evidence = { sha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), builtAssets: Boolean(staticServer), fixtureOnly: true, liveProviderE2E: false, checks: [], consoleErrors: [], pageErrors: [], unexpectedWrites: [], externalRequests: [], unavailableFixtureReads: [] };
const browser = await chromium.launch({ executablePath: process.env.SHIBA_CHROMIUM || "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
await context.addInitScript(() => {
  localStorage.setItem("shiba.employee-onboarding.dismissed", "true");
  localStorage.setItem("onboarding", "done");
  sessionStorage.setItem("shiba:first-run-seed:ux-fixture", "1");
});
await context.routeWebSocket("**/agents/**", (socket) => socket.close());
await context.routeWebSocket("**/api/**", (socket) => socket.close());
await context.route("**/*", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.origin !== new URL(origin).origin) {
    evidence.externalRequests.push(url.origin + url.pathname);
    return route.abort();
  }
  if (!url.pathname.startsWith("/api/") && !/^\/agents\/[^/]+\//.test(url.pathname)) return route.continue();
  if (!["GET", "HEAD"].includes(request.method())) {
    evidence.unexpectedWrites.push({ method: request.method(), path: url.pathname, body: request.postData() });
    return route.fulfill({ status: 403, json: { error: "Fixture harness blocks all mutations" } });
  }
  if (["/api/activity", "/api/usage"].includes(url.pathname)) {
    evidence.unavailableFixtureReads.push(url.pathname);
    return route.fulfill({ status: 503, json: { error: "This report is unavailable in the UX fixture" } });
  }
  let body = empty;
  if (url.pathname === "/api/whoami") body = { agent: "ux-fixture", auth: "access" };
  else if (url.pathname === "/api/approvals") body = { approvals: [approval], decided: [] };
  else if (/\/runs$/.test(url.pathname)) body = { runs };
  else if (/\/runs\/ux-/.test(url.pathname)) body = { run: runs.find((run) => url.pathname.endsWith(run.runId)) };
  else if (url.pathname === "/api/custom-agents") body = { agents: [{ id: "ux-employee", slug: "ux-employee", version: 1, config: { name: "Fixture employee", instructions: "Fixture instructions only", harness: "opencode" } }] };
  else if (url.pathname === "/api/setup/status") body = setup;
  return route.fulfill({ json: body });
});
const page = await context.newPage();
page.on("console", (message) => { if (message.type() === "error") evidence.consoleErrors.push(message.text()); });
page.on("pageerror", (error) => evidence.pageErrors.push(error.message));
async function check(name, action) {
  const errorStart = evidence.consoleErrors.length;
  try { await action(); assert(!evidence.consoleErrors.slice(errorStart).some((message) => /Dashboard render error|The above error occurred/.test(message)), "React error boundary caught a render failure"); evidence.checks.push({ name, passed: true }); }
  catch (error) { evidence.checks.push({ name, passed: false, error: String(error) }); await page.screenshot({ path: path.join(output, `failure-${evidence.checks.length}.png`) }); }
  await writeFile(path.join(output, "results.json"), JSON.stringify(evidence, null, 2));
}
async function open(target) {
  await page.goto(origin + target);
  await page.waitForFunction(() => document.querySelector("main") || document.querySelector("nav"));
}
try {
  await check("legacy app entry and fixture work statuses", async () => {
    await open("/app/?tab=work&view=board");
    await page.getByRole("region", { name: "Board view", exact: true }).getByText("Running fixture", { exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, "/work/");
    for (const title of ["Completed fixture", "Failed fixture", "Unknown fixture", "PR fixture", "Frozen approval fixture"]) await page.getByText(title, { exact: true }).first().waitFor();
    await page.screenshot({ path: path.join(output, "work-desktop.png") });
  });
  for (const [target, expected] of [["/app/?tab=run-registry", "/analytics/"], ["/app/?view=mailbox", "/inbox/"], ["/app/?tab=orchestrator", "/activity/"], ["/settings/?section=appearance", "/settings/"], ["/memory/", "/memory/"], ["/spaces/", "/spaces/"], ["/custom-agents/", "/custom-agents/"]]) {
    await check(`reloadable legacy surface ${target}`, async () => {
      await open(target);
      await page.waitForURL((url) => url.pathname === expected);
      await page.reload();
      await page.waitForFunction(() => document.querySelector("main") || document.querySelector("nav"));
      assert.equal(new URL(page.url()).pathname, expected);
    });
  }
  for (const view of canonicalViews) {
    await check(`canonical surface /${view}/`, async () => {
      await open(`/${view}/`);
      await page.waitForURL((url) => url.pathname === `/${view}/`);
      // A selected path alone is insufficient: wait for identity resolution and content.
      await page.waitForFunction(() => !document.body.innerText.includes("Checking your session…"));
      assert(!(await page.locator("body").innerText()).includes("Something went wrong"), "Error boundary rendered");
      if (["custom-agents", "memory"].includes(view)) await page.screenshot({ path: path.join(output, `${view}-desktop.png`) });
    });
  }
  await check("run and prompt deep links remain on Threads", async () => {
    await open("/app/?run=ux-run-0");
    await page.waitForURL((url) => url.pathname === "/threads/");
    await open("/app/?prompt=UX_FIXTURE_DRAFT_ONLY");
    await page.waitForURL((url) => url.pathname === "/threads/");
    await page.locator("textarea").filter({ visible: true }).first().waitFor();
    assert((await page.locator("textarea").evaluateAll((nodes) => nodes.map((node) => node.value))).includes("UX_FIXTURE_DRAFT_ONLY"));
    assert(!new URL(page.url()).searchParams.has("prompt"), "Consumed prompt remains in address");
  });
  await check("mobile workspace fits viewport", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open("/work/?view=board");
    await page.getByRole("region", { name: "Board view", exact: true }).getByText("Running fixture", { exact: true }).waitFor();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Document overflows mobile viewport");
    await page.screenshot({ path: path.join(output, "work-mobile.png") });
  });
  await check("no unhandled browser or hydration errors", async () => {
    assert.deepEqual(evidence.pageErrors, []);
    assert(!evidence.consoleErrors.some((message) => /hydration|#418|Minified React error/i.test(message)), "Hydration error found");
  });
  await check("no fixture writes escaped", async () => assert.deepEqual(evidence.unexpectedWrites, []));
} finally {
  await browser.close();
  if (staticServer) await new Promise((resolve) => staticServer.close(resolve));
  await writeFile(path.join(output, "results.json"), JSON.stringify(evidence, null, 2));
}
console.log(JSON.stringify({ output, ...evidence }, null, 2));
if (evidence.checks.some((check) => !check.passed)) process.exitCode = 1;
