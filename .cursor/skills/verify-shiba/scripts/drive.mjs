#!/usr/bin/env node
import { chromium } from "playwright";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const verifyDir = join(root, ".verify");
const port = existsSync(join(verifyDir, "port"))
  ? readFileSync(join(verifyDir, "port"), "utf8").trim()
  : process.env.PORT || "8788";
const feature = process.argv.includes("--feature")
  ? process.argv[process.argv.indexOf("--feature") + 1]
  : "task-submit-and-approval";
const url = `http://127.0.0.1:${port}/app/`;
const outDir = join(verifyDir, "drive");
mkdirSync(outDir, { recursive: true });

function dockerIds() {
  try {
    return execSync("docker ps -aq", { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  } catch {
    return null;
  }
}

const before = dockerIds();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ recordHar: { path: join(outDir, "session.har") } });
await context.tracing.start({ screenshots: true, snapshots: true });
const page = await context.newPage();
const shots = [];
async function shot(name) {
  const path = join(outDir, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  shots.push(path);
}

const result = {
  feature,
  url,
  githubMode: existsSync(join(verifyDir, "github-mode"))
    ? readFileSync(join(verifyDir, "github-mode"), "utf8").trim()
    : "unknown",
  label: "mock GitHub",
};
try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  const skip = page.getByRole("button", { name: "Skip setup" });
  if (await skip.count()) await skip.click();
  await page.getByLabel("Task composer").waitFor({ timeout: 30000 });
  await shot("01-app");
  await page.getByLabel("Task description").fill("verify-shiba: describe the README in one sentence");
  await page.getByLabel(/^Project:/).click();
  const search = page.getByLabel("Search repositories");
  if (await search.count()) await search.fill("cloudflare/ai-chat");
  const urlBox = page.locator("input[type=url]");
  await urlBox.first().fill("https://github.com/cloudflare/ai-chat");
  await page.getByRole("button", { name: "Use" }).click();
  if (feature === "pr-publish" || feature === "review-findings") {
    await page.getByRole("button", { name: "Thread configuration" }).click();
    const pr = page.getByRole("menuitemcheckbox", { name: /Create pull request/ });
    if ((await pr.getAttribute("aria-checked")) !== "true") await pr.click();
    const review = page.getByRole("menuitemcheckbox", { name: /Read-only review/ });
    if (await review.count()) {
      if ((await review.getAttribute("aria-checked")) !== "true") await review.click();
    }
  }
  await shot("02-composer-filled");
  await page.getByLabel("Send task").click();
  await shot("03-sent");
  const approve = page.getByRole("button", { name: "Approve" });
  const reject = page.getByRole("button", { name: "Reject" });
  try {
    await approve.first().waitFor({ timeout: 90000 });
  } catch {
    result.approvalVisible = false;
  }
  result.approvalVisible = (await approve.count()) > 0;
  const card = page.locator("text=/read-only review/i");
  result.reviewCopyVisible = (await card.count()) > 0;
  await shot("04-after-send");
  if (feature === "task-submit-and-approval" && result.approvalVisible) {
    await reject.first().click();
    await page.waitForTimeout(1500);
    await shot("05-rejected");
    result.rejected = true;
  }
  if (feature === "sandbox-run-and-diff" || feature === "pr-publish" || feature === "review-findings") {
    if (result.approvalVisible) {
      await approve.first().click();
      await shot("05-approved");
      result.approved = true;
    }
  }
  if (feature === "run-registry-status") {
    await page.goto(`${url}?tab=runs`, { waitUntil: "domcontentloaded" });
    await shot("06-runs");
  }
  const after = dockerIds();
  result.dockerBefore = before;
  result.dockerAfter = after;
  result.dockerDiffEmpty =
    before !== null && after !== null && before.join() === after.join();
  const runs = await page.request.get(`http://127.0.0.1:${port}/api/runs`);
  writeFileSync(join(outDir, "runs.json"), await runs.text());
  writeFileSync(join(outDir, "result.json"), JSON.stringify(result, null, 2));
  await context.tracing.stop({ path: join(outDir, "trace.zip") });
  await context.close();
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error);
  writeFileSync(join(outDir, "result.json"), JSON.stringify(result, null, 2));
  try { await shot("error"); } catch { /* page may be gone */ }
  try { await context.tracing.stop({ path: join(outDir, "trace.zip") }); } catch { /* already stopped */ }
  try { await context.close(); } catch { /* already closed */ }
  throw error;
} finally {
  await browser.close();
}
