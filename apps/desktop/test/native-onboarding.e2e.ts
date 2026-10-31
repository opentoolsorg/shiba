import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type ElectronApplication, _electron as electron, type Page } from "playwright-core";
import { expect, test } from "vitest";
import { startWorkerFixture } from "../../backend/test/acceptance/worker-fixture.mjs";

interface Progress {
  draftTaskId: string;
  draftTask: { version: number; goal: string; audience: string; acceptance: string; preparedAt: number | null };
}

async function progress(page: Page): Promise<Progress> {
  return page.evaluate(async () => {
    const response = await fetch("/api/onboarding/progress");
    if (!response.ok) throw new Error(`Onboarding progress HTTP ${response.status}`);
    return response.json();
  });
}

test("actual native shared UI preserves a first-task goal, named thread and Work draft across process restart", async () => {
  const fixture = await startWorkerFixture();
  const userData = await mkdtemp(path.join(tmpdir(), "shiba-native-onboarding-"));
  let app: ElectronApplication | undefined;
  const launch = () => electron.launch({
    chromiumSandbox: true,
    args: ["test/electron-bootstrap.cjs"],
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: userData, TMPDIR: tmpdir(), SHELL: "",
      SHIBA_DESKTOP_URL: fixture.origin, SHIBA_DESKTOP_TEST_USER_DATA: userData,
      SHIBA_LOCAL_RUN_ROOT: path.join(userData, "daemon"),
    },
  });
  const goal = "Prepare a native fixture research brief without external calls.";
  const audience = "The fixture review team";
  const acceptance = "Return a concise brief using supplied facts and identify every missing source.";
  const threadName = "Native fixture retained thread";
  async function answer(page: Page, label: string, value: string) {
    await page.getByRole("textbox", { name: `Your answer: ${label}`, exact: true }).fill(value);
    await page.getByRole("button", { name: "Send answer", exact: true }).click();
  }
  try {
    app = await launch();
    let page = await app.firstWindow();
    page.setDefaultTimeout(15_000);
    await page.waitForURL(`${fixture.origin}/app/**`);
    await page.getByRole("button", { name: "First sign-in? Create the account" }).click();
    await page.getByLabel("Name", { exact: true }).fill("Native Fixture Owner");
    await page.getByLabel("Email", { exact: true }).fill("native-owner@example.test");
    await page.getByLabel("Password", { exact: true }).fill("native-fixture-only-password-2026!");
    await page.getByRole("button", { name: "Create account", exact: true }).click();
    await page.getByRole("region", { name: "First task setup", exact: true }).waitFor();
    await answer(page, "Goal", goal);
    await page.getByRole("textbox", { name: "Your answer: Audience", exact: true }).fill(audience);
    await expect.poll(async () => (await progress(page)).draftTask.goal).toBe(goal);
    const savedGoal = await progress(page);
    expect(savedGoal.draftTaskId).toMatch(/^draft_/);
    await app.close(); app = undefined;

    app = await launch();
    page = await app.firstWindow();
    page.setDefaultTimeout(15_000);
    await page.waitForURL(`${fixture.origin}/app/**`);
    await expect.poll(() => page.getByRole("textbox", { name: "Your answer: Audience", exact: true }).inputValue()).toBe(audience);
    expect((await progress(page)).draftTaskId).toBe(savedGoal.draftTaskId);
    await answer(page, "Audience", audience);
    await answer(page, "Acceptance", acceptance);
    await page.getByRole("textbox", { name: "Your answer: Your role", exact: true }).waitFor();
    await page.getByRole("button", { name: "Skip question", exact: true }).click();
    await page.getByRole("textbox", { name: "Your answer: Help", exact: true }).waitFor();
    await page.getByRole("button", { name: "Skip question", exact: true }).click();
    await page.getByRole("button", { name: /Research Produce a sourced report/ }).click();
    await answer(page, "Context", "Fixture facts only. This answer grants no source access.");
    await page.getByRole("button", { name: "I will use supplied context first", exact: true }).click();
    await page.getByRole("button", { name: "Create first task draft", exact: true }).click();
    await page.getByRole("heading", { name: "First task draft saved", exact: true }).waitFor();
    const prepared = await progress(page);
    expect(prepared).toMatchObject({ draftTaskId: savedGoal.draftTaskId, draftTask: { goal, audience, acceptance, preparedAt: expect.any(Number) } });
    await page.getByRole("button", { name: "Use first task draft in Work", exact: true }).click();
    await page.getByRole("group", { name: "Selected first-task goal", exact: true }).waitFor();
    await expect.poll(() => page.getByLabel("Task description").inputValue()).toContain(goal);
    await page.getByRole("button", { name: "New thread", exact: true }).click();
    await page.getByRole("button", { name: "Rename thread", exact: true }).click();
    await page.getByLabel("Thread name", { exact: true }).fill(threadName);
    await page.getByRole("button", { name: "Save name", exact: true }).click();
    await page.getByRole("form", { name: "Rename thread", exact: true }).waitFor({ state: "detached" });
    await page.getByRole("tab", { name: "Work", exact: true }).click();
    await page.getByRole("region", { name: "Saved first task draft", exact: true }).getByRole("button", { name: "Use first task draft", exact: true }).click();
    await page.getByRole("group", { name: "Selected first-task goal", exact: true }).waitFor();
    await app.close(); app = undefined;

    app = await launch();
    page = await app.firstWindow();
    page.setDefaultTimeout(15_000);
    await page.waitForURL(`${fixture.origin}/app/**`);
    await page.getByRole("tab", { name: "Work", exact: true }).click();
    await page.getByRole("button", { name: "Rename thread", exact: true }).waitFor();
    await page.getByRole("region", { name: "Saved first task draft", exact: true }).waitFor();
    await page.getByRole("group", { name: "Selected first-task goal", exact: true }).waitFor();
    await expect.poll(() => page.getByLabel("Task description").inputValue()).toContain(goal);
    const resumed = await progress(page);
    expect(resumed.draftTaskId).toBe(prepared.draftTaskId);
    expect(resumed.draftTask.version).toBe(prepared.draftTask.version);
    expect(resumed.draftTask.preparedAt).toBe(prepared.draftTask.preparedAt);
    const threads = await page.evaluate(async () => {
      const response = await fetch("/api/sessions");
      if (!response.ok) throw new Error(`Threads HTTP ${response.status}`);
      return response.json() as Promise<{ sessions: Array<{ id: string; name: string }> }>;
    });
    expect(threads.sessions.some((thread) => thread.name === threadName)).toBe(true);
    expect(await app.evaluate(() => (globalThis as { __protocolRegistrations?: number }).__protocolRegistrations)).toBe(0);
    expect(await page.evaluate(() => typeof (window as unknown as { shibaDesktop?: unknown }).shibaDesktop)).toBe("object");
    const evidence = fileURLToPath(new URL("../../../.verify/native-onboarding/", import.meta.url));
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: path.join(evidence, "restarted-goal-thread.png") });
  } finally {
    try { await app?.close(); }
    finally {
      await fixture.stop();
      await rm(userData, { recursive: true, force: true });
    }
  }
}, 180_000);
