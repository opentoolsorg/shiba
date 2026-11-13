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
import { openAppView, selectRepositoryTask } from "../.cursor/skills/verify-shiba/scripts/composer-target.mjs";

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
runs[0].signals = [{ kind: "working", at: now - 80000 }];
runs[1].hasDiff = true;
runs[1].diff = "diff --git a/fixture.txt b/fixture.txt\n--- a/fixture.txt\n+++ b/fixture.txt\n@@ -1 +1 @@\n-before-fixture\n+after-fixture\n";
runs[1].summary = "Retained fixture output; no live provider execution occurred.";
const approval = { approvalId: "ux-approval", threadKey: "", task: "Frozen approval fixture", repoUrl: "https://github.com/fixture/example", kind: "run", status: "pending", createdAt: now, payload: { repoUrl: "https://github.com/fixture/example", task: "FROZEN_UX_PAYLOAD", baseBranch: "main", publishPullRequest: false } };
const approvals = [approval];
let allowQueueFixture = false;
let allowDecisionFixture = false;
const empty = { workspaces: [], sessions: [], runs: [], approvals: [], decided: [], agents: [], principals: [], connections: [], computers: [], entries: [], sources: [], projects: [], spaces: [], tasks: [], items: [], members: [], providers: [], facts: [], mailboxes: [], automations: [], events: [], outbox: [], skills: [], servers: [] };
const setup = { slack: { signingSecret: false, botToken: false, approvers: 0, channelRepos: false }, github: { token: false, app: false, publish: false, webhookSecret: false }, linear: { webhookSecret: false, apiToken: false, defaultRepo: false }, slackVerification: { signingSecret: false }, gateway: { id: "", token: false, reachable: "unknown" }, access: { required: true }, betterAuth: { configured: false }, models: { orchestrator: "", coding: "", harness: "opencode", roles: [] }, automations: { enabled: false, typeSafe: false }, mailbox: { addressOverride: false, sendEnabled: false }, doctor: { ok: false, checkedAt: now, findings: [], roles: [] } };
const evidence = { sha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), trackedChanges: execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim(), builtAssets: Boolean(staticServer), fixtureOnly: true, liveProviderE2E: false, checks: [], consoleErrors: [], pageErrors: [], unexpectedWrites: [], permittedFixtureWrites: [], externalRequests: [], unavailableFixtureReads: [] };
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
    if (allowDecisionFixture && request.method() === "POST" && url.pathname === "/api/approvals") {
      const body = request.postDataJSON();
      const record = approvals.find((item) => item.approvalId === "ux-queued-from-chat");
      if (record && body.approvalId === record.approvalId && body.threadKey === record.threadKey && body.approved === true) {
        evidence.permittedFixtureWrites.push({ method: "POST", path: url.pathname, body });
        record.status = "approved";
        runs.push({ ...runs[1], runId: "ux-server-approved-run", task: record.task, approval: { approvalId: record.approvalId }, expectedDeliverables: ["deliverables/brief.md"], deliverables: [{ path: "deliverables/brief.md", mediaType: "text/markdown", bytes: 32, sha256: "ab".repeat(32) }], summary: "Completed execution fixture; no live model or container." });
        return route.fulfill({ json: { result: "approved" } });
      }
    }
    if (allowQueueFixture && request.method() === "POST" && url.pathname === "/api/runs") {
      const body = request.postDataJSON();
      if (body.task === "QUEUE_UX_FIXTURE_FOR_HUMAN_REVIEW" && body.executionTarget?.kind === "artifact-workspace") {
        evidence.permittedFixtureWrites.push({ method: "POST", path: url.pathname, body });
        approvals.push({ approvalId: "ux-queued-from-chat", threadKey: "", kind: "run", status: "pending", task: body.task, repoUrl: "", createdAt: Date.now(), payload: body, executionTarget: body.executionTarget });
        return route.fulfill({ json: { ok: true, approvalId: "ux-queued-from-chat" } });
      }
    }
    evidence.unexpectedWrites.push({ method: request.method(), path: url.pathname, body: request.postData() });
    return route.fulfill({ status: 403, json: { error: "Fixture harness blocks all mutations" } });
  }
  if (["/api/activity", "/api/usage"].includes(url.pathname)) {
    evidence.unavailableFixtureReads.push(url.pathname);
    return route.fulfill({ status: 503, json: { error: "This report is unavailable in the UX fixture" } });
  }
  let body = empty;
  if (url.pathname === "/api/whoami") body = { agent: "ux-fixture", auth: "access" };
  else if (url.pathname === "/api/approvals") body = { approvals, decided: [] };
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
  await check("Work board/list/timeline retain accurate execution states and Organization", async () => {
    await open("/work/?view=board");
    await page.getByTestId("board-column-attention").getByText("Failed fixture", { exact: true }).waitFor();
    await page.getByTestId("board-column-attention").getByText("Unknown fixture", { exact: true }).waitFor();
    await page.getByTestId("board-column-pr_open").getByText("PR fixture", { exact: true }).waitFor();
    await page.getByTestId("board-column-done").getByText("Completed fixture", { exact: true }).waitFor();
    assert.equal(await page.getByTestId("board-column-done").getByText("Failed fixture", { exact: true }).count(), 0);
    await open("/work/?view=list");
    await page.getByRole("region", { name: /^Completed -/ }).getByText("Completed fixture", { exact: true }).waitFor();
    await page.getByRole("region", { name: /^Needs attention -/ }).getByText("Failed fixture", { exact: true }).waitFor();
    await open("/work/?view=timeline");
    const timeline = page.getByRole("list", { name: "Timeline tasks", exact: true });
    await timeline.getByText("Failed fixture", { exact: true }).waitFor();
    assert.match(await timeline.locator("li").filter({ hasText: "Failed fixture" }).innerText(), /Error|Failed/i);
    assert.match(await timeline.locator("li").filter({ hasText: "PR fixture" }).innerText(), /PR linked/i);
    await open("/work/?view=organization");
    await page.getByRole("region", { name: "Organization view", exact: true }).waitFor();
  });
  await check("Work drawer native focus, Back/Forward, reload and Escape", async () => {
    await open("/work/?view=board&source=ux#keep");
    const trigger = page.getByTestId("board-card-run:ux-run-0").getByRole("button", { name: "Running fixture", exact: true });
    await trigger.click();
    const drawer = page.getByRole("dialog", { name: "Work inspector: Running fixture", exact: true });
    await drawer.waitFor();
    assert(await drawer.evaluate((node) => node.matches(":modal")));
    assert(await drawer.getByRole("button", { name: "Close task", exact: true }).evaluate((node) => node === document.activeElement));
    assert.equal(new URL(page.url()).pathname, "/work/");
    assert.equal(new URL(page.url()).searchParams.get("task"), "ux-run-0");
    await page.keyboard.press("Shift+Tab");
    assert(await drawer.evaluate((node) => node.contains(document.activeElement)));
    await page.keyboard.press("Tab");
    await drawer.getByRole("list", { name: "Recorded run steps", exact: true }).getByText("working", { exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, "work-inspector-desktop.png") });
    await page.goBack();
    await drawer.waitFor({ state: "detached" });
    assert(await trigger.evaluate((node) => node === document.activeElement));
    await page.goForward();
    await drawer.waitFor();
    await page.reload();
    await drawer.waitFor();
    assert.equal(new URL(page.url()).searchParams.get("source"), "ux");
    assert.equal(new URL(page.url()).hash, "#keep");
    await page.keyboard.press("Escape");
    await drawer.waitFor({ state: "detached" });
    assert(!new URL(page.url()).searchParams.has("task"));
    assert.equal(new URL(page.url()).searchParams.get("view"), "board");
  });
  await check("Work inspector tabs restore retained diff and output without success inference", async () => {
    await open("/work/?view=list&task=ux-run-1&taskKind=run&tab=diff");
    const drawer = page.getByRole("dialog", { name: "Work inspector: Completed fixture", exact: true });
    await drawer.waitFor();
    await drawer.getByText("after-fixture", { exact: false }).first().waitFor();
    await drawer.getByRole("tab", { name: "Output", exact: true }).click();
    await drawer.getByText(runs[1].summary, { exact: true }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get("tab"), "output");
    await page.goBack();
    await drawer.getByRole("tab", { name: "Diff", exact: true }).waitFor();
    await page.waitForFunction(() => new URLSearchParams(location.search).get("tab") === "diff");
    await page.reload();
    await drawer.getByText("after-fixture", { exact: false }).first().waitFor();
    await drawer.getByRole("button", { name: "Close task", exact: true }).click();
    await drawer.waitFor({ state: "detached" });
  });
  await check("Work approval drawer reuses the frozen card and original decision controls", async () => {
    await open("/work/?view=board&task=ux-approval&taskKind=approval");
    const drawer = page.getByRole("dialog", { name: "Work inspector: Frozen approval fixture", exact: true });
    await drawer.waitFor();
    assert.equal(await drawer.getByRole("tab", { name: "Approval", exact: true }).getAttribute("aria-selected"), "true");
    assert.deepEqual(JSON.parse(await drawer.locator("pre").innerText()), approval.payload);
    await drawer.getByRole("button", { name: "Approve", exact: true }).waitFor();
    await drawer.getByRole("button", { name: "Reject", exact: true }).waitFor();
    assert.equal(await drawer.getByRole("button", { name: /Modify|Edit command/i }).count(), 0);
    await page.screenshot({ path: path.join(output, "work-frozen-approval-desktop.png") });
    await drawer.getByRole("button", { name: "Open approval queue", exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/approvals/");
    assert(!new URL(page.url()).searchParams.has("task"));
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
  await check("repository browser helpers navigate the five-area shell", async () => {
    for (const [view, pathname] of [["Agents", "/custom-agents/"], ["Chats", "/threads/"], ["Approvals", "/approvals/"], ["Pull requests", "/diff/"], ["Integrations", "/integrations/"]]) {
      await openAppView(page, view);
      await page.waitForURL((url) => url.pathname === pathname);
    }
    await openAppView(page, "Chats");
    await selectRepositoryTask(page);
    await page.getByRole("button", { name: /^Project:/ }).click();
    await page.getByRole("textbox", { name: "Repository", exact: true }).fill("https://github.com/fixture/example");
    await page.getByTestId("task-composer").getByRole("button", { name: "Use", exact: true }).click();
    await page.getByRole("button", { name: "Project: fixture/example", exact: true }).waitFor();
    await page.getByRole("button", { name: "Thread configuration", exact: true }).click();
    const configuration = page.getByRole("menu", { name: "Thread configuration", exact: true });
    const defaultAgent = configuration.getByRole("menuitemradio", { checked: true }).filter({ hasText: "Shiba" });
    await defaultAgent.waitFor();
    await defaultAgent.press("Escape");
    await page.getByRole("tab", { name: "Chat", exact: true }).click();
  });
  await check("run and prompt deep links remain on Threads", async () => {
    await open("/app/?run=ux-run-0");
    await page.waitForURL((url) => url.pathname === "/threads/");
    await open("/app/?prompt=UX_FIXTURE_DRAFT_ONLY");
    await page.waitForURL((url) => url.pathname === "/threads/");
    await page.locator("textarea").filter({ visible: true }).first().waitFor();
    assert((await page.locator("textarea").evaluateAll((nodes) => nodes.map((node) => node.value))).includes("UX_FIXTURE_DRAFT_ONLY"));
    assert(!new URL(page.url()).searchParams.has("prompt"), "Consumed prompt remains in address");
  });
  await check("Chat draft moves to existing Work review without dispatch", async () => {
    await open("/threads/");
    const draft = page.getByRole("form", { name: "Chat composer" }).locator("textarea");
    await draft.fill("@Fixture review the release plan; do not execute yet");
    await page.screenshot({ path: path.join(output, "chat-draft-desktop.png") });
    await page.getByRole("button", { name: "Review as work", exact: true }).click();
    const work = page.getByRole("form", { name: "Task composer", exact: true });
    await work.waitFor();
    assert.equal(await work.getByRole("textbox", { name: "Task description", exact: true }).inputValue(), "@Fixture review the release plan; do not execute yet");
    assert.equal(new URL(page.url()).pathname, "/threads/");
    await page.screenshot({ path: path.join(output, "chat-work-draft-desktop.png") });
    await page.getByRole("tab", { name: "Chat", exact: true }).click();
    assert.equal(await draft.inputValue(), "@Fixture review the release plan; do not execute yet");
  });
  await check("fixture Chat-to-Work queue reaches the existing frozen approval card", async () => {
    await open("/threads/");
    const draft = page.getByRole("form", { name: "Chat composer" }).locator("textarea");
    await draft.fill("QUEUE_UX_FIXTURE_FOR_HUMAN_REVIEW");
    await page.getByRole("button", { name: "Review as work", exact: true }).click();
    const work = page.getByRole("form", { name: "Task composer", exact: true });
    await work.getByRole("combobox", { name: "Work target", exact: true }).selectOption("artifact-workspace");
    allowQueueFixture = true;
    try {
      await work.getByRole("button", { name: "Send task", exact: true }).click();
      await page.getByText(/^Draft queued — review and approve/).first().waitFor();
    } finally { allowQueueFixture = false; }
    assert.equal(evidence.permittedFixtureWrites.length, 1);
    await page.waitForURL((url) => url.pathname === "/work/" && url.searchParams.get("task") === "ux-queued-from-chat");
    const approvalDrawer = page.getByRole("dialog", { name: "Work inspector: QUEUE_UX_FIXTURE_FOR_HUMAN_REVIEW", exact: true });
    await approvalDrawer.waitFor();
    await page.getByText("QUEUE_UX_FIXTURE_FOR_HUMAN_REVIEW", { exact: true }).first().waitFor();
    const frozen = await approvalDrawer.locator("pre").evaluateAll((nodes) => nodes.map((node) => {
      try { return JSON.parse(node.textContent); } catch { return null; }
    }));
    assert(frozen.some((body) => JSON.stringify(body) === JSON.stringify(evidence.permittedFixtureWrites[0].body)), "Frozen approval differs from the queued fixture request");
    assert.equal(approvals.at(-1).status, "pending");
    await page.screenshot({ path: path.join(output, "chat-to-approval-fixture.png") });
    allowDecisionFixture = true;
    try { await approvalDrawer.getByRole("button", { name: "Approve", exact: true }).click(); }
    finally { allowDecisionFixture = false; }
    await page.waitForURL((url) => url.searchParams.get("task") === "ux-server-approved-run" && url.searchParams.get("taskKind") === "run");
    const runDrawer = page.getByRole("dialog", { name: "Work inspector: QUEUE_UX_FIXTURE_FOR_HUMAN_REVIEW", exact: true });
    await runDrawer.waitFor();
    await page.reload();
    await runDrawer.waitFor();
    await runDrawer.getByRole("tab", { name: "Diff", exact: true }).click();
    await runDrawer.getByText("after-fixture", { exact: false }).first().waitFor();
    await runDrawer.getByRole("tab", { name: "Output", exact: true }).click();
    await runDrawer.getByRole("link", { name: "Download deliverables/brief.md", exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, "chat-approval-to-run-output-fixture.png") });
  });
  await check("saved employee search and profile preserve read-only focus flow", async () => {
    await open("/custom-agents/");
    const search = page.getByRole("searchbox", { name: "Search employees", exact: true });
    const profile = page.getByRole("button", { name: "View profile Fixture employee", exact: true });
    await profile.waitFor();
    await search.fill("does-not-match-ux-fixture");
    assert.equal(await profile.count(), 0);
    await search.fill("Fixture");
    await profile.click();
    const overview = page.getByRole("region", { name: "Fixture employee overview", exact: true });
    await overview.waitFor();
    assert(await overview.evaluate((node) => node === document.activeElement));
    await page.screenshot({ path: path.join(output, "employee-profile-desktop.png") });
    await page.getByRole("button", { name: "Close profile", exact: true }).click();
    assert(await profile.evaluate((node) => node === document.activeElement));
  });
  await check("Knowledge shortcuts retain unsaved source text and keyboard focus", async () => {
    await open("/memory/");
    await page.getByRole("button", { name: /^Sources/ }).filter({ visible: true }).first().click();
    const text = page.getByRole("textbox", { name: "TEXT TO REMEMBER", exact: true });
    await text.fill("Unsaved UX fixture architecture note");
    await page.getByRole("button", { name: /^Search memory/ }).click();
    const recall = page.getByRole("form", { name: "Recall from memory", exact: true });
    assert(await recall.evaluate((node) => node === document.activeElement));
    await page.getByRole("button", { name: /^Add a note/ }).click();
    assert.equal(await text.inputValue(), "Unsaved UX fixture architecture note");
    await page.screenshot({ path: path.join(output, "knowledge-draft-desktop.png") });
  });
  await check("bootstrap verification keeps its dedicated non-submitting callback", async () => {
    await open("/app/?verify=bootstrap#bootstrapVerification=INVALID_UX_PROOF");
    await page.getByRole("heading", { name: "Confirm your dashboard email" }).waitFor();
    assert.equal(new URL(page.url()).hash, "");
    assert(!(await page.locator("body").innerText()).includes("INVALID_UX_PROOF"));
    assert.equal(await page.getByRole("button", { name: "Confirm email", exact: true }).count(), 0);
    assert.equal(await page.getByRole("navigation", { name: "App Icon Rail" }).count(), 0);
  });
  await check("Slack Canvas remains separate and read-only", async () => {
    await open("/slack-canvas/");
    await page.getByRole("heading", { name: "Slack run canvas" }).waitFor();
    await page.getByText("This run link is invalid.", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: /^Approve/ }).count(), 0);
  });
  await check("invitation fragment is consumed without exposing or submitting it", async () => {
    const invitation = "a".repeat(64);
    await open(`/app/#invite=${invitation}`);
    await page.waitForFunction(() => !location.hash);
    assert(!(await page.locator("body").innerText()).includes(invitation));
  });
  await check("mobile workspace fits viewport", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open("/work/?view=board");
    await page.getByRole("region", { name: "Board view", exact: true }).getByText("Running fixture", { exact: true }).waitFor();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Document overflows mobile viewport");
    await page.screenshot({ path: path.join(output, "work-mobile.png") });
  });
  await check("mobile navigation Escape closes the sheet and restores focus", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open("/work/");
    const trigger = page.getByRole("button", { name: "Open navigation", exact: true });
    await trigger.click();
    await page.getByRole("button", { name: "Close navigation", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Close navigation", exact: true }).waitFor({ state: "detached" });
    assert(await trigger.evaluate((node) => node === document.activeElement));
  });
  for (const theme of ["light", "dark"]) for (const width of [390, 768, 1440]) {
    await check(`responsive ${theme} theme at ${width}px`, async () => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await page.evaluate((value) => localStorage.setItem("shiba-theme", value), theme);
      for (const view of ["work", "custom-agents", "memory"]) {
        await open(view === "work" ? "/work/?view=board" : `/${view}/`);
        if (view === "work") {
          await page.getByRole("region", { name: "Board view", exact: true }).waitFor();
          await page.getByTestId("board-card-approval:ux-approval").getByRole("button", { name: "Frozen approval fixture", exact: true }).click();
          const drawer = page.getByRole("dialog", { name: "Work inspector: Frozen approval fixture", exact: true });
          await drawer.waitFor();
          assert(await drawer.evaluate((node) => node.matches(":modal")));
          assert((await drawer.boundingBox()).width <= width);
          await page.screenshot({ path: path.join(output, `inspector-${theme}-${width}.png`) });
          await page.keyboard.press("Escape");
          await drawer.waitFor({ state: "detached" });
        }
        if (view === "custom-agents") await page.getByRole("heading", { name: "Your employee roster", exact: true }).waitFor();
        if (view === "memory") {
          const source = width >= 1024 ? page.getByRole("button", { name: /^Sources/ }).filter({ visible: true }).first() : page.getByRole("button", { name: "Workspace Memory", exact: true });
          await source.click();
          await page.getByRole("heading", { name: "Knowledge & context", exact: true }).waitFor();
        }
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${view} overflows at ${width}px`);
        assert.equal(await page.evaluate(() => document.documentElement.classList.contains("dark")), theme === "dark");
        await page.screenshot({ path: path.join(output, `${view}-${theme}-${width}.png`) });
      }
    });
  }
  await check("no unhandled browser or hydration errors", async () => {
    assert.deepEqual(evidence.pageErrors, []);
    assert(!evidence.consoleErrors.some((message) => /hydration|#418|Minified React error/i.test(message)), "Hydration error found");
  });
  await check("no unexpected writes or external requests escaped the fixture boundary", async () => {
    assert.deepEqual(evidence.unexpectedWrites, []);
    assert.deepEqual(evidence.externalRequests, []);
  });
} finally {
  await browser.close();
  if (staticServer) await new Promise((resolve) => staticServer.close(resolve));
  await writeFile(path.join(output, "results.json"), JSON.stringify(evidence, null, 2));
}
console.log(JSON.stringify({ output, ...evidence }, null, 2));
if (evidence.checks.some((check) => !check.passed)) process.exitCode = 1;
