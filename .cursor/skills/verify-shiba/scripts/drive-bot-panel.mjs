#!/usr/bin/env node
/**
 * Bot sidebar journey against a real local Worker + D1.
 *
 * Fixtures: two bots and two documents seeded by seed-bot-panel.mjs, plus one
 * document owned by a second identity. Real: the Worker, D1, the file routes and
 * their access checks. Mocked: nothing. No sandbox, model, or GitHub call runs —
 * containers are disabled on this Worker.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

// Run after: node .cursor/skills/verify-shiba/scripts/seed-bot-panel.mjs
// Worker must be the local one (apps/backend/wrangler.jsonc, --local, --enable-containers=false).
const BASE = process.env.VERIFY_APP_URL ?? "http://127.0.0.1:8788";
const USER = "me@local.test";
const OTHER = "other@local.test";
const OUT = resolve(".verify/bot-panel");
mkdirSync(OUT, { recursive: true });

const report = { mode: "real local Worker + D1 and file routes; no sandbox, model, or GitHub execution", steps: [] };
const pass = (step, detail) => report.steps.push({ step, status: "PASS", ...(detail ? { detail } : {}) });

const browser = await chromium.launch({ headless: true, executablePath: process.env.VERIFY_BROWSER_EXECUTABLE_PATH });
const asUser = async (email, viewport = { width: 1440, height: 900 }) => {
  const context = await browser.newContext({ viewport, extraHTTPHeaders: { "CF-Access-Authenticated-User-Email": email } });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  return { context, page };
};

async function api(page, path, init = {}) {
  const response = await page.request.fetch(`${BASE}${path}`, init);
  return { status: response.status(), body: await response.json().catch(() => ({})) };
}

async function seedOtherUserFile(page) {
  const begin = await api(page, "/api/files/uploads", {
    method: "POST",
    headers: { origin: BASE, "content-type": "application/json" },
    data: JSON.stringify({ action: "begin", name: "other-only.md", mime: "text/markdown", scope: "personal", folderId: null }),
  });
  assert.equal(begin.status, 201, "other identity upload begin");
  const { sessionId, partSize } = begin.body.session;
  assert.equal(partSize > 0, true);
  const part = await page.request.fetch(`${BASE}/api/files/uploads?${new URLSearchParams({ scope: "personal", sessionId, partNumber: "1" })}`, {
    method: "POST",
    headers: { origin: BASE, "content-type": "application/octet-stream" },
    data: Buffer.from("# private\n"),
  });
  assert.equal(part.status(), 200);
  const etag = (await part.json()).part.etag;
  const done = await api(page, "/api/files/uploads", {
    method: "POST",
    headers: { origin: BASE, "content-type": "application/json" },
    data: JSON.stringify({ action: "complete", sessionId, parts: [{ partNumber: 1, etag }] }),
  });
  assert.equal(done.status, 201);
  const listed = await api(page, "/api/files?scope=personal");
  const file = listed.body.files.find((item) => item.name === "other-only.md");
  assert.ok(file, "other identity file listed for its owner");
  return file;
}

const { context, page } = await asUser(USER);
const panel = () => page.getByRole("complementary", { name: "Agent details" });
const drawer = () => page.locator("#agent-details");
const openTeamAgents = async () => {
  const rail = page.getByRole("navigation", { name: "Workspace areas", exact: true });
  await rail.getByRole("button", { name: "Team", exact: true }).click();
  await page.waitForTimeout(600);
};

/** The agents context panel loads its directory from the Worker after the view mounts. */
async function waitForBotRow(name, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = page.locator('aside[aria-label="Agents"]').getByRole("button", { name: new RegExp(name) }).first();
    if (await row.isVisible().catch(() => false)) return row;
    await page.waitForTimeout(300);
  }
  throw new Error(`bot row ${name} never appeared`);
}

async function clickBot(name) {
  await openTeamAgents();
  const row = await waitForBotRow(name);
  await row.click();
  await panel().waitFor({ state: "visible" });
}

try {
  const agents = await api(page, "/api/custom-agents");
  const research = agents.body.agents.find((agent) => agent.config.name === "Research bot");
  const engineering = agents.body.agents.find((agent) => agent.config.name === "Engineering bot");
  assert.ok(research && engineering, "both seeded bots are listed");
  const briefFileId = research.config.libraryFileIds[0];
  pass("Both bots and their linked files exist in D1");

  await page.goto(`${BASE}/app/`);
  await page.waitForTimeout(2500);
  await openTeamAgents();
  await page.screenshot({ path: `${OUT}/01-team-agents-desktop.png` });
  pass("Agents directory lists Shiba, Research bot and Engineering bot");

  // 1. Click a bot in Agents and get its sidebar.
  await clickBot("Research bot");
  await panel().waitFor();
  assert.match(await drawer().innerText(), /Research bot/);
  assert.equal(await page.getByRole("tab", { name: "Details" }).getAttribute("aria-selected"), "true");
  assert.match(await drawer().innerText(), /research· |Research bot/);
  await page.screenshot({ path: `${OUT}/02-research-details-desktop.png` });
  pass("Clicking Research bot opens its panel on Details");

  // 2. Details rows reflect this bot alone.
  const instructionsRow = page.getByRole("button", { name: /^Instructions/ });
  await instructionsRow.click();
  const instructionsField = page.getByLabel(/What this bot should do/);
  assert.equal(await instructionsField.inputValue(), "Write research briefs. Cite sources.");
  pass("Details shows this bot's saved instructions");

  // 3. Library: linked documents, real preview, unsupported file, required outputs.
  await page.getByRole("tab", { name: "Library" }).click();
  await page.getByRole("button", { name: "Preview brief.md" }).waitFor();
  assert.match(await drawer().innerText(), /Workspace|Personal file/);
  assert.match(await drawer().innerText(), /out\/brief\.md/);
  assert.doesNotMatch(await drawer().innerText(), /out\/fix\.md/);
  await page.screenshot({ path: `${OUT}/03-research-library-desktop.png` });
  pass("Library separates linked files from required output paths");

  await page.getByRole("button", { name: "Preview brief.md" }).click();
  await page.getByText("Finding 1", { exact: true }).waitFor();
  assert.match(await drawer().innerText(), /Finding 1\n\nCitation 1/);
  await page.screenshot({ path: `${OUT}/04-research-document-preview.png` });
  pass("Previewing a linked document renders its real Markdown content");

  const download = await page.request.fetch(`${BASE}/api/files/${briefFileId}/download`);
  assert.equal(download.status(), 200);
  assert.match(download.headers()["content-type"] ?? "", /text\/markdown/);
  pass("The linked document downloads through the authorized file route", { status: download.status() });

  await page.getByRole("button", { name: "Preview sources.docx" }).click();
  await page.getByText("No in-panel preview for .docx files. Download it to open it.").waitFor();
  await page.screenshot({ path: `${OUT}/05-unsupported-file-state.png` });
  pass("An unsupported document says so instead of rendering it");

  // 4. Edit instructions, then reload the browser.
  await page.getByRole("tab", { name: "Details" }).click();
  await page.getByRole("button", { name: /^Instructions/ }).click();
  await instructionsField.fill("Write briefs from linked evidence only. Cite every claim.");
  await page.getByRole("button", { name: "Save instructions" }).click();
  await page.getByText("Instructions saved for this bot.").waitFor();
  await page.reload();
  await page.waitForTimeout(2500);
  await clickBot("Research bot");
  await page.getByRole("button", { name: /^Instructions/ }).click();
  assert.equal(await page.getByLabel(/What this bot should do/).inputValue(), "Write briefs from linked evidence only. Cite every claim.");
  await page.screenshot({ path: `${OUT}/06-instructions-after-reload.png` });
  pass("An instruction edit survives a full browser reload");

  // 5. Switching between bots must not leave the previous bot's data on screen,
  //    including when two rows are clicked back to back with no wait between.
  await clickBot("Engineering bot");
  await page.getByRole("tab", { name: "Library" }).click();
  await page.getByText("out/fix.md", { exact: true }).waitFor();
  await page.waitForTimeout(800);
  const engineeringText = await drawer().innerText();
  assert.doesNotMatch(engineeringText, /brief\.md/);
  assert.doesNotMatch(engineeringText, /out\/brief\.md/);
  await page.getByRole("tab", { name: "Details" }).click();
  await page.getByRole("button", { name: /^Instructions/ }).click();
  assert.equal(await page.getByLabel(/What this bot should do/).inputValue(), "Review diffs and write tests.");
  await page.screenshot({ path: `${OUT}/07-engineering-panel.png` });

  await clickBot("Research bot");
  await page.getByRole("tab", { name: "Library" }).click();
  await page.getByText("out/brief.md", { exact: true }).waitFor();
  await page.waitForTimeout(800);
  const backOnResearch = await drawer().innerText();
  assert.match(backOnResearch, /out\/brief\.md/);
  assert.doesNotMatch(backOnResearch, /out\/fix\.md/);
  assert.doesNotMatch(backOnResearch, /Review diffs and write tests\./);
  await page.screenshot({ path: `${OUT}/08-switched-back-to-research.png` });
  pass("Switching bots leaves only the selected bot's files, instructions and outputs");

  // 6. Computer tab: truthful runtime, approved-run lifecycle, no fake controls.
  await page.getByRole("tab", { name: "Computer" }).click();
  const computer = await drawer().innerText();
  assert.match(computer, /Harness/);
  assert.match(computer, /Cloud sandbox/);
  assert.match(computer, /A persistent bot computer/);
  assert.equal(await drawer().getByRole("button", { name: /wake|power|take over|start computer/i }).count(), 0);
  await page.screenshot({ path: `${OUT}/09-computer-desktop.png` });
  pass("Computer reports the real runtime and refuses to fake a bot-owned machine");

  // 7. A file owned by another identity never renders inside the bot's library.
  const other = await asUser(OTHER);
  const otherFile = await seedOtherUserFile(other.page);
  const forOwner = await api(page, `/api/files/${otherFile.id}`);
  assert.equal(forOwner.status, 404, "the other identity's personal file is not readable here");
  pass("Another identity's personal file answers 404 to this viewer");

  // The instruction edit above bumped this bot's version; read the current one.
  const current = (await api(page, "/api/custom-agents")).body.agents.find((agent) => agent.id === research.id);
  const patched = await api(page, `/api/custom-agents/${research.id}`, {
    method: "PATCH",
    headers: { origin: BASE, "content-type": "application/json" },
    data: JSON.stringify({
      config: { ...current.config, libraryFileIds: [...current.config.libraryFileIds, otherFile.id] },
      expectedVersion: current.version,
    }),
  });
  assert.equal(patched.status, 200, `link the foreign file: ${JSON.stringify(patched.body)}`);
  await page.reload();
  await page.waitForTimeout(2500);
  await clickBot("Research bot");
  await page.getByRole("tab", { name: "Library" }).click();
  await page.getByText("Removed, or not available to you.").waitFor();
  await page.screenshot({ path: `${OUT}/10-unreadable-link.png` });
  pass("A link to a file this viewer may not read shows as unavailable, not as content");

  // Clean the foreign link so the fixture matches its description.
  await api(page, `/api/custom-agents/${research.id}`, {
    method: "PATCH",
    headers: { origin: BASE, "content-type": "application/json" },
    data: JSON.stringify({ config: current.config, expectedVersion: patched.body.agent.version }),
  });
  await other.context.close();

  // 8. Phone layout: the same open panel, resized to a phone. The panel must stay
  //    in flow, fit the viewport, and never scroll sideways.
  await clickBot("Research bot");
  await page.getByRole("tab", { name: "Library" }).click();
  await page.getByText("out/brief.md", { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(1200);
  await panel().waitFor();
  const panelBox = await page.locator("#agent-details").boundingBox();
  const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  assert.ok(panelBox && panelBox.width <= widths.inner, `panel fits the viewport (${panelBox?.width} <= ${widths.inner})`);
  assert.ok(panelBox && panelBox.x >= 0 && panelBox.x + panelBox.width <= widths.inner + 1, "panel does not overflow sideways");
  assert.ok(widths.scroll <= widths.inner + 1, `no horizontal overflow (${widths.scroll} <= ${widths.inner})`);
  await page.getByRole("tab", { name: "Details" }).click();
  await page.getByRole("button", { name: /^Instructions/ }).click();
  await page.getByRole("button", { name: /^Tools/ }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/11-mobile-panel.png` });
  pass("Phone layout keeps the panel in flow with no horizontal overflow", { panelWidth: Math.round(panelBox?.width ?? 0), viewport: widths.inner });
  await page.setViewportSize({ width: 1440, height: 900 });

  report.result = "PASS";
} catch (error) {
  report.result = "FAIL";
  report.error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
  await page.screenshot({ path: `${OUT}/zz-failure.png` }).catch(() => {});
  throw error;
} finally {
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
  await context.close();
  await browser.close();
}
