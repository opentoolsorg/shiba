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

const headless = process.env.VERIFY_HEADLESS !== "0";
const navigationTimeout = Number(process.env.VERIFY_DRIVE_TIMEOUT_MS || 60_000);
const before = dockerIds();
const browser = await chromium.launch({ headless });
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
  page.setDefaultTimeout(navigationTimeout);
  page.setDefaultNavigationTimeout(navigationTimeout);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: navigationTimeout });
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
  const useRunsApi =
    process.env.VERIFY_USE_RUNS_API === "1" ||
    process.env.VERIFY_ENABLE_CONTAINERS === "0";
  if (useRunsApi) {
    const commandId = crypto.randomUUID();
    const queueRes = await page.request.post(`http://127.0.0.1:${port}/api/runs`, {
      data: {
        repoUrl: "https://github.com/cloudflare/ai-chat",
        task: "verify-shiba: describe the README in one sentence",
        baseBranch: "main",
        harness: "opencode",
        publishPullRequest:
          feature === "pr-publish" || feature === "review-findings",
        reviewAfterPublish: feature === "review-findings",
        commandId,
      },
    });
    if (!queueRes.ok()) {
      throw new Error(`POST /api/runs failed: ${queueRes.status()} ${await queueRes.text()}`);
    }
    result.queuedViaRunsApi = true;
    await page.goto(`${url}?tab=approvals`, { waitUntil: "domcontentloaded" });
  } else {
    await page.getByLabel("Send task").click();
  }
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
      // Several cards can be pending; approve the one that states the review.
      const reviewCard = page.locator("div").filter({ hasText: /read-only review/i }).filter({ has: page.getByRole("button", { name: "Approve" }) }).last();
      const target = (await reviewCard.count()) ? reviewCard.getByRole("button", { name: "Approve" }) : approve.first();
      await target.click();
      await page.waitForTimeout(4000);
      await shot("05-approved");
      result.approved = true;
    }
  }
  if (feature === "byo-models-ux") {
    const settings = page.getByRole("button", { name: /Settings/i });
    if (await settings.count()) await settings.first().click();
    const modelsNav = page.getByRole("button", { name: "Models" });
    if (await modelsNav.count()) await modelsNav.click();
    await page.getByTestId("model-connections-card").waitFor({ timeout: 15000 });
    await shot("06-models-settings");
    const testBtn = page.getByTestId("test-connection").first();
    if (await testBtn.count()) {
      await testBtn.click();
      await page.waitForTimeout(2000);
      await shot("07-connection-tested");
      result.connectionTestClicked = true;
    }
    const cfg = await page.request.get(`http://127.0.0.1:${port}/api/model-config`);
    writeFileSync(join(outDir, "model-config.json"), await cfg.text());
    result.modelConfigStatus = cfg.status();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    const usage = page.getByTestId("run-usage");
    result.runUsageVisible = (await usage.count()) > 0;
    if (result.runUsageVisible) await shot("08-run-usage");
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
