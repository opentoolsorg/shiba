import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type ElectronApplication, _electron as electron, type Page } from "playwright-core";
import { expect, test } from "vitest";
import { startWorkerFixture } from "../../backend/test/acceptance/worker-fixture.mjs";

interface Progress {
  draftTaskId: string;
  draftTask: {
    version: number;
    goal: string;
    audience: string;
    acceptance: string;
    contextAnswer: string;
    preparedAt: number | null;
    employeeId: string | null;
    employeeVersion: number | null;
  };
  activatedAt: number | null;
  evidence: { connectedProvider: boolean | null; acceptedDeliverable: boolean | null };
}

async function api<T>(
  page: Page,
  url: string,
  init?: { method: string; headers: Record<string, string>; body: string },
): Promise<T> {
  return page.evaluate(
    async ({ url, init }) => {
      const response = await fetch(url, init);
      if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
      return response.json();
    },
    { url, init },
  );
}

const progress = (page: Page) => api<Progress>(page, "/api/onboarding/progress");

test("actual native shared UI retains goal, thread, approved output and review across process restart", async () => {
  const fixture = await startWorkerFixture({ localRuntime: true });
  const userData = await mkdtemp(path.join(tmpdir(), "shiba-native-onboarding-"));
  let app: ElectronApplication | undefined;
  const nativeLogs: string[] = [];
  const launch = async () => {
    const native = await electron.launch({
      chromiumSandbox: true,
      args: ["test/electron-bootstrap.cjs"],
      env: {
        ...Object.fromEntries(["DISPLAY", "XAUTHORITY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR"].flatMap((key) => process.env[key] ? [[key, process.env[key]]] : [])),
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: userData,
        TMPDIR: tmpdir(),
        SHELL: "",
        SHIBA_DESKTOP_URL: fixture.origin,
        SHIBA_DESKTOP_TEST_USER_DATA: userData,
        SHIBA_LOCAL_RUN_ROOT: path.join(userData, "daemon"),
      },
    });
    native.process().stderr?.on("data", (chunk: Buffer) => {
      nativeLogs.push(chunk.toString().slice(-4096));
      if (nativeLogs.length > 20) nativeLogs.shift();
    });
    native
      .process()
      .on("exit", (code, signal) => nativeLogs.push(`Electron exit ${code}/${signal}`));
    return native;
  };
  const goal = "Prepare a native fixture research brief without external calls.";
  const audience = "The fixture review team";
  const acceptance =
    "Return a concise brief using supplied facts and identify every missing source.";
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
    expect(await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem("shiba-composer-drafts-v1") ?? "{}") as Record<string, { text: string }>).map((entry) => entry.text))).toContain(audience);
    await app.close();
    app = undefined;

    app = await launch();
    page = await app.firstWindow();
    page.setDefaultTimeout(15_000);
    await page.waitForURL(`${fixture.origin}/app/**`);
    await expect
      .poll(() =>
        page.getByRole("textbox", { name: "Your answer: Audience", exact: true }).inputValue(),
      { timeout: 15_000 })
      .toBe(audience);
    expect((await progress(page)).draftTaskId).toBe(savedGoal.draftTaskId);
    await answer(page, "Audience", audience);
    await answer(page, "Acceptance", acceptance);
    await page.getByRole("textbox", { name: "Your answer: Your role", exact: true }).waitFor();
    await page.getByRole("button", { name: "Skip question", exact: true }).click();
    await page.getByRole("textbox", { name: "Your answer: Help", exact: true }).waitFor();
    await page.getByRole("button", { name: "Skip question", exact: true }).click();
    await page.getByRole("button", { name: /Research Produce a sourced report/ }).click();
    await answer(page, "Context", "Fixture facts only. This answer grants no source access.");
    await page
      .getByRole("button", { name: "I will use supplied context first", exact: true })
      .click();
    await page.getByRole("button", { name: "Create first task draft", exact: true }).click();
    await page.getByRole("heading", { name: "First task draft saved", exact: true }).waitFor();
    const prepared = await progress(page);
    expect(prepared).toMatchObject({
      draftTaskId: savedGoal.draftTaskId,
      draftTask: { goal, audience, acceptance, preparedAt: expect.any(Number) },
    });
    await page.getByRole("button", { name: "Use first task draft in Work", exact: true }).click();
    await page.getByRole("group", { name: "Selected first-task goal", exact: true }).waitFor();
    await expect.poll(() => page.getByLabel("Task description").inputValue()).toContain(goal);
    await page.getByRole("button", { name: "New thread", exact: true }).click();
    await page.getByRole("button", { name: "Rename thread", exact: true }).click();
    await page.getByLabel("Thread name", { exact: true }).fill(threadName);
    await page.getByRole("button", { name: "Save name", exact: true }).click();
    await page
      .getByRole("form", { name: "Rename thread", exact: true })
      .waitFor({ state: "detached" });
    await page.getByRole("tab", { name: "Work", exact: true }).click();
    await page
      .getByRole("region", { name: "Saved first task draft", exact: true })
      .getByRole("button", { name: "Use first task draft", exact: true })
      .click();
    await page.getByRole("group", { name: "Selected first-task goal", exact: true }).waitFor();
    await app.close();
    app = undefined;

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
    expect(
      await app.evaluate(
        () => (globalThis as { __protocolRegistrations?: number }).__protocolRegistrations,
      ),
    ).toBe(0);
    expect(
      await page.evaluate(
        () => typeof (window as unknown as { shibaDesktop?: unknown }).shibaDesktop,
      ),
    ).toBe("object");
    const evidence = fileURLToPath(new URL("../../../.verify/native-onboarding/", import.meta.url));
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: path.join(evidence, "restarted-goal-thread.png") });

    await page.goto(`${fixture.origin}/custom-agents/`);
    await page.getByText("Advanced settings", { exact: true }).click();
    await page.getByPlaceholder("security-reviewer").fill("native-fixture-researcher");
    await page.getByPlaceholder("Security reviewer").fill("Native Fixture Researcher");
    await page
      .getByPlaceholder("Standing instructions prepended to every run")
      .fill("Use only supplied fixture facts. Produce the required report for human review.");
    await page.getByLabel("Required deliverables").fill("reports/native-fixture.md");
    await page.getByRole("button", { name: "Create bot", exact: true }).click();
    let employee: { id: string; version: number } | undefined;
    await expect
      .poll(async () => {
        employee = (
          await api<{ agents: Array<{ id: string; version: number; config: { name: string } }> }>(
            page,
            "/api/custom-agents",
          )
        ).agents.find((agent) => agent.config.name === "Native Fixture Researcher");
        return employee?.id;
      })
      .toBeTruthy();
    if (!employee) throw new Error("Fixture employee was not persisted");
    await page.goto(`${fixture.origin}/`);
    await page.getByRole("tab", { name: "Work", exact: true }).click();
    await page.getByRole("button", { name: "Review setup draft", exact: true }).click();
    await page.getByRole("button", { name: "Edit employee", exact: true }).click();
    await page.getByText("Use an existing employee", { exact: true }).click();
    await page
      .getByRole("button", {
        name: `Native Fixture Researcher · v${employee.version}`,
        exact: true,
      })
      .click();
    await page.getByRole("region", { name: "First task draft review", exact: true }).waitFor();
    expect((await progress(page)).draftTask.contextAnswer).toBe("Fixture facts only. This answer grants no source access.");
    await page.getByRole("button", { name: "Create first task draft", exact: true }).click();
    await page.getByRole("heading", { name: "First task draft saved", exact: true }).waitFor();
    const executable = await progress(page);
    expect(executable.draftTask).toMatchObject({
      employeeId: employee.id,
      employeeVersion: employee.version,
    });
    expect(executable.activatedAt).toBeNull();
    await page.getByRole("button", { name: "Use first task draft in Work", exact: true }).click();
    if (
      await page.getByRole("alertdialog", { name: "Replace unsent task", exact: true }).isVisible()
    )
      await page.getByRole("button", { name: "Replace with saved draft", exact: true }).click();

    const pairing = await api<{ token: string }>(page, "/api/computers/pairing-token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const pairedResponse = await fetch(`${fixture.origin}/api/local/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pairingToken: pairing.token,
        hostname: "native-fixture-adapter",
        platform: "linux-x64",
        daemonVersion: "0.1.0",
        harnesses: ["opencode"],
      }),
    });
    expect(pairedResponse.status).toBe(200);
    const paired = (await pairedResponse.json()) as { adapterToken: string; machineId: string };
    async function adapterPost<T>(route: string, body: unknown): Promise<T> {
      const response = await fetch(`${fixture.origin}${route}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${paired.adapterToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!response.ok)
        throw new Error(`${route} HTTP ${response.status}: ${await response.text()}`);
      return response.json() as Promise<T>;
    }
    await adapterPost("/api/local/heartbeat", {
      machineId: paired.machineId,
      hostname: "native-fixture-adapter",
      platform: "linux-x64",
      daemonVersion: "0.1.0",
      harnesses: ["opencode"],
    });
    const composer = page.getByTestId("task-composer");
    await composer.getByRole("button", { name: "Thread configuration", exact: true }).click();
    await page.getByRole("menuitemradio", { name: /Native Fixture Researcher/ }).click();
    await page.keyboard.press("Escape");
    // ponytail: supported repository-target adapter fixture; no checkout, model or GitHub call occurs.
    await composer.getByRole("button", { name: "Project: Select repository", exact: true }).click();
    await page
      .getByPlaceholder("https://github.com/owner/repo")
      .fill("https://github.com/opentoolsorg/shiba");
    await page.getByRole("button", { name: "Use", exact: true }).click();
    await composer.getByRole("button", { name: "Run on: Cloud", exact: true }).click();
    await page.getByRole("button", { name: "Refresh paired computers", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect
      .poll(() =>
        composer
          .getByLabel("Local computer", { exact: true })
          .locator(`option[value="${paired.machineId}"]`)
          .count(),
      )
      .toBe(1);
    await composer.getByLabel("Local computer", { exact: true }).selectOption(paired.machineId);
    await page.keyboard.press("Escape");
    await composer.getByRole("button", { name: "Send task", exact: true }).click();
    await page
      .getByRole("main")
      .getByText(/Queued — approve the run card to execute on this computer/)
      .waitFor();
    const session = threads.sessions.find((thread) => thread.name === threadName);
    if (!session) throw new Error("Named fixture thread missing");
    const sessionQuery = `?session=${encodeURIComponent(session.id)}`;
    const approvals = await api<{ approvals: Array<Record<string, unknown>> }>(
      page,
      `/api/approvals${sessionQuery}`,
    );
    expect(approvals.approvals).toHaveLength(1);
    expect(JSON.stringify(approvals.approvals[0])).toContain(executable.draftTaskId);
    expect(JSON.stringify(approvals.approvals[0])).toContain(goal);
    expect(
      (
        await adapterPost<{ envelope?: unknown }>("/api/local/claim", {
          operator: "native-fixture-adapter",
        })
      ).envelope,
    ).toBeFalsy();
    await page.goto(`${fixture.origin}/approvals/`);
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    type Claim = {
      claimToken: string;
      envelope?: {
        sandboxId: string;
        task: string;
        customAgentId: string;
        customAgentVersion: number;
        expectedDeliverables: string[];
      };
    };
    let claim: Claim | undefined;
    await expect
      .poll(async () => {
        claim = await adapterPost<Claim>("/api/local/claim", {
          operator: "native-fixture-adapter",
        });
        return claim.envelope?.sandboxId;
      })
      .toBeTruthy();
    if (!claim?.envelope) throw new Error("Approved native fixture task was not claimed");
    expect(claim.envelope).toMatchObject({
      customAgentId: employee.id,
      customAgentVersion: employee.version,
      expectedDeliverables: ["reports/native-fixture.md"],
    });
    expect(claim.envelope.task).toContain(goal);
    const output =
      "# Native fixture brief\n\nSupplied facts: this is an isolated local acceptance fixture.\nMissing sources: no external sources were granted.\n";
    await adapterPost("/api/local/result", {
      sandboxId: claim.envelope.sandboxId,
      claimToken: claim.claimToken,
      result: {
        status: "completed",
        exitCode: 0,
        summary: "Deterministic fixture output; no model invoked.",
        stderrTail: "",
        stdoutTail: "fixture adapter completed",
        changedFiles: ["reports/native-fixture.md"],
        diff: "diff --git a/reports/native-fixture.md b/reports/native-fixture.md\n+native fixture brief\n",
        files: [{ path: "reports/native-fixture.md", content: output, encoding: "utf8" }],
        signals: [
          {
            kind: "exec.settled",
            at: Date.now(),
            detail: '{"command":"native deterministic fixture adapter","exit":0}',
          },
        ],
      },
    });
    let run:
      | {
          runId: string;
          status: string;
          onboardingTask?: { draftTaskId: string; draftTaskVersion: number };
        }
      | undefined;
    await expect
      .poll(async () => {
        const runs = await api<{ runs: NonNullable<typeof run>[] }>(page, `/api/runs${sessionQuery}`);
        const failed = runs.runs.find((item) => ["error", "aborted", "unknown"].includes(item.status));
        if (failed) throw new Error(`Native fixture run failed: ${JSON.stringify(failed)}`);
        run = runs.runs.find((item) => item.status === "completed");
        return run?.runId;
      }, { timeout: 15_000 })
      .toBeTruthy();
    if (!run) throw new Error("Native fixture run did not complete");
    await page.goto(`${fixture.origin}/`);
    await page.getByRole("tab", { name: "Work", exact: true }).click();
    await page.getByLabel("Review decision for reports/native-fixture.md").selectOption("approved");
    await page.getByRole("button", { name: "Save review", exact: true }).click();
    await page.getByText("Current saved review: approved", { exact: true }).waitFor();
    await expect.poll(async () => (await progress(page)).evidence.acceptedDeliverable).toBe(true);
    expect((await progress(page)).activatedAt).toEqual(expect.any(Number));
    expect((await progress(page)).evidence.connectedProvider).toBe(false);
    const artifactRoute = `/api/runs/${encodeURIComponent(run.runId)}/deliverables/0${sessionQuery}`;
    const retainedText = () =>
      page.evaluate(async (route) => {
        const response = await fetch(route);
        if (!response.ok) throw new Error(`Artifact HTTP ${response.status}`);
        return response.text();
      }, artifactRoute);
    expect(await retainedText()).toBe(output);
    await app.close();
    app = undefined;
    app = await launch();
    page = await app.firstWindow();
    page.setDefaultTimeout(15_000);
    await page.getByRole("tab", { name: "Work", exact: true }).click();
    await page.getByText("Current saved review: approved", { exact: true }).waitFor();
    expect(await retainedText()).toBe(output);
    expect((await progress(page)).draftTaskId).toBe(executable.draftTaskId);
    expect((await progress(page)).draftTask.version).toBe(executable.draftTask.version);
    expect((await progress(page)).evidence.acceptedDeliverable).toBe(true);
    expect(
      (await api<{ sessions: Array<{ name: string }> }>(page, "/api/sessions")).sessions.some(
        (thread) => thread.name === threadName,
      ),
    ).toBe(true);
    expect(
      (
        await adapterPost<{ envelope?: unknown }>("/api/local/claim", {
          operator: "native-fixture-adapter",
        })
      ).envelope,
    ).toBeFalsy();
    expect(
      await app.evaluate(
        () => (globalThis as { __protocolRegistrations?: number }).__protocolRegistrations,
      ),
    ).toBe(0);
    await page.screenshot({ path: path.join(evidence, "restarted-retained-output.png") });
  } catch (error) {
    console.error(nativeLogs.join("\n"));
    throw error;
  } finally {
    try {
      await app?.close();
    } finally {
      await fixture.stop();
      await rm(userData, { recursive: true, force: true });
    }
  }
}, 180_000);
