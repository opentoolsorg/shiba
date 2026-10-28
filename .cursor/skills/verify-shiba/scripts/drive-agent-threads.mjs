#!/usr/bin/env node
/** Local-only browser regression: profile → new thread → rename → refresh. No model calls. */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const base = new URL(process.env.VERIFY_APP_URL ?? "http://localhost:5173");
assert(["localhost", "127.0.0.1", "[::1]"].includes(base.hostname), "This smoke test writes local fixture records only.");
const output = resolve(".verify/agent-threads");
mkdirSync(output, { recursive: true });
const report = { mode: "real local Worker/D1; no model, GitHub, or container execution", steps: [] };
const browser = await chromium.launch({
  headless: true,
  ...(process.env.VERIFY_BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.VERIFY_BROWSER_EXECUTABLE_PATH } : {}),
});
const context = await browser.newContext();
await context.tracing.start({ screenshots: true, snapshots: true });
const page = await context.newPage();
page.setDefaultTimeout(30_000);
const stamp = Date.now();
const name = `Browser auditor ${stamp}`;
const renamed = `Renamed audit ${stamp}`;
const passed = (step) => report.steps.push({ step, status: "PASS" });
let fixtureAgentId;
let fixtureSessionId;
async function openBotsDirectory() {
  await page.goto(new URL("/app/", base).href);
  await page.getByRole("navigation", { name: "Main", exact: true }).locator('button[aria-haspopup="true"]').click();
  await page.getByRole("menuitem", { name: "Bots", exact: true }).click();
}
try {
  await openBotsDirectory();
  await page.getByRole("button", { name: "Create bot", exact: true }).waitFor();
  await page.getByLabel("Slug", { exact: true }).fill(`browser-auditor-${stamp}`);
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Instructions", { exact: true }).fill("Review locally and require approval before any execution.");
  await page.getByLabel("Default repository", { exact: true }).fill("https://github.com/opentoolsorg/shiba");
  const createdResponse = page.waitForResponse((response) => response.url().endsWith("/api/custom-agents") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Create bot", exact: true }).click();
  const created = await createdResponse;
  assert.equal(created.status(), 201);
  const { agent } = await created.json();
  fixtureAgentId = agent.id;
  await page.getByRole("button", { name: `Launch bot ${name}`, exact: true }).waitFor();
  passed("Create a custom bot through its form and persist it in the local Worker");

  const sessionResponse = page.waitForResponse((response) => response.url().endsWith("/api/sessions") && response.request().method() === "POST");
  await page.getByRole("button", { name: `Launch bot ${name}`, exact: true }).click();
  const sessionCreated = await sessionResponse;
  assert.equal(sessionCreated.status(), 201);
  const { session } = await sessionCreated.json();
  fixtureSessionId = session.id;
  assert.equal(session.metadata.customAgentId, agent.id);
  await page.getByText(`Bot: ${name}`, { exact: true }).waitFor();
  await page.getByLabel("Task composer").waitFor();
  passed("Start a fresh bot-associated thread and select its profile in the composer");

  // A failed rename must remain retryable and must not silently change persisted state.
  const renamePath = `**/api/sessions/${session.id}`;
  await page.route(renamePath, async (route) => {
    if (route.request().method() === "PATCH") {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Browser fixture: temporary rename outage" }) });
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Rename thread", exact: true }).click();
  await page.getByLabel("Thread name", { exact: true }).fill(renamed);
  await page.getByRole("button", { name: "Save name", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Browser fixture: temporary rename outage" }).waitFor();
  const unchanged = await (await page.request.get(new URL(`/api/sessions/${session.id}`, base).href)).json();
  assert.equal(unchanged.session.name, name);
  passed("Failed rename shows an error and preserves the existing thread name");
  await page.unroute(renamePath);

  await page.getByRole("button", { name: "Save name", exact: true }).click();
  await page.getByLabel("Thread name", { exact: true }).waitFor({ state: "hidden" });
  const saved = await (await page.request.get(new URL(`/api/sessions/${session.id}`, base).href)).json();
  assert.equal(saved.session.name, renamed);
  assert.equal(saved.session.metadata.customAgentId, agent.id);
  passed("Retry saves the new name through the real session PATCH API");
  await page.screenshot({ path: resolve(output, "renamed-thread.png"), fullPage: true });

  await page.reload();
  await page.getByRole("option").filter({ hasText: renamed }).first().click();
  await page.getByText(`Bot: ${name}`, { exact: true }).waitFor();
  await page.getByRole("button", { name: "Rename thread", exact: true }).waitFor();
  const persisted = await (await page.request.get(new URL("/api/sessions", base).href)).json();
  assert(persisted.sessions.some((item) => item.id === session.id && item.name === renamed && item.metadata?.customAgentId === agent.id));
  passed("Refresh preserves the renamed thread and restores its bot profile on selection");

  await page.getByRole("option").filter({ hasText: "Default Session" }).first().click();
  await page.getByText(`Bot: ${name}`, { exact: true }).waitFor({ state: "hidden" });
  assert.equal(await page.getByRole("button", { name: "Rename thread", exact: true }).count(), 0);
  await page.getByRole("option").filter({ hasText: renamed }).first().click();
  await page.getByText(`Bot: ${name}`, { exact: true }).waitFor();
  passed("Switching to the protected default session clears the bot; returning restores it");

  await openBotsDirectory();
  const botThreads = page.getByRole("list", { name: `${name} threads`, exact: true });
  await botThreads.getByRole("button").filter({ hasText: renamed }).click();
  await page.getByText(`Bot: ${name}`, { exact: true }).waitFor();
  await page.getByRole("button", { name: "Rename thread", exact: true }).waitFor();
  passed("The bot card lists and reopens its persisted associated conversation");

  await page.getByRole("button", { name: "Rename thread", exact: true }).click();
  const nameInput = page.getByLabel("Thread name", { exact: true });
  await nameInput.waitFor();
  assert(await nameInput.evaluate((input) => input === document.activeElement), "Rename field did not receive keyboard focus");
  await nameInput.press("Escape");
  await nameInput.waitFor({ state: "hidden" });
  passed("The rename form focuses its field and closes with Escape");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("Task composer").waitFor();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "Mobile layout overflows horizontally");
  await page.screenshot({ path: resolve(output, "mobile-thread.png"), fullPage: true });
  passed("Thread composer renders at 390px without horizontal page overflow");
  report.fixture = { agentId: agent.id, sessionId: session.id };
  report.status = "PASS";
} catch (error) {
  report.status = "FAIL";
  report.error = String(error);
  await page.screenshot({ path: resolve(output, "failure.png"), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  // Remove only IDs returned by this invocation's fixture creation requests.
  report.cleanup = [];
  for (const [kind, id] of [["sessions", fixtureSessionId], ["custom-agents", fixtureAgentId]]) {
    if (!id) continue;
    try {
      const response = await page.request.delete(new URL(`/api/${kind}/${encodeURIComponent(id)}`, base).href);
      report.cleanup.push({ kind, status: response.status() });
      assert(response.ok(), `Could not remove own ${kind} fixture (${response.status()})`);
    } catch (error) {
      report.status = "FAIL";
      report.cleanupError = String(error);
      process.exitCode = 1;
    }
  }
  writeFileSync(resolve(output, "result.json"), JSON.stringify(report, null, 2));
  await context.tracing.stop({ path: resolve(output, "trace.zip") });
  await browser.close();
  console.log(JSON.stringify(report, null, 2));
}
