import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";

let fixture: Server;
let otherOrigin: Server;
let fixtureUrl = "";
let otherUrl = "";
let actionCount = 0;
let hangingRequests = 0;
const siteBridgeChecks: string[] = [];
const siteCookies: string[] = [];
const actionCookies: string[] = [];
const userDataDirs: string[] = [];

beforeAll(async () => {
  fixture = createServer((req, res) => {
    const url = new URL(req.url ?? "/", fixtureUrl || "http://127.0.0.1");
    if (url.pathname === "/app/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><title>Dashboard fixture</title>");
      return;
    }
    if (url.pathname === "/hang") {
      hangingRequests += 1;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).flushHeaders();
      return;
    }
    if (url.pathname === "/clicked" && req.method === "POST") {
      actionCount += 1;
      actionCookies.push(req.headers.cookie ?? "");
      res.writeHead(204).end();
      return;
    }
    if (url.pathname === "/bridge-check") {
      siteBridgeChecks.push(url.searchParams.get("value") ?? "");
      siteCookies.push(req.headers.cookie ?? "");
      res.writeHead(204).end();
      return;
    }
    if (url.pathname !== "/") {
      res.writeHead(404).end();
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("set-cookie", "shiba_local_test=temporary; Path=/; SameSite=Lax");
    res.end(`<!doctype html><meta charset="utf-8"><title>Local fixture</title>
      <button id="task" type="button">Increase counter</button>
      <fieldset disabled><button type="button">Disabled by fieldset</button></fieldset>
      <script>
        fetch('/bridge-check?value=' + encodeURIComponent(typeof window.shibaLocalBrowser));
        document.querySelector('#task').addEventListener('click', () => { document.cookie = 'session_marker=created; Path=/'; fetch('/clicked', { method: 'POST' }); });
      </script>`);
  });
  otherOrigin = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end("<!doctype html><title>Other origin</title>");
  });
  await Promise.all([
    new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve)),
    new Promise<void>((resolve) => otherOrigin.listen(0, "127.0.0.1", resolve)),
  ]);
  fixtureUrl = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
  otherUrl = `http://127.0.0.1:${(otherOrigin.address() as AddressInfo).port}`;
});

afterAll(async () => {
  fixture.closeAllConnections();
  otherOrigin.closeAllConnections();
  await Promise.all([
    new Promise<void>((resolve) => fixture.close(() => resolve())),
    new Promise<void>((resolve) => otherOrigin.close(() => resolve())),
  ]);
  for (const dir of userDataDirs) rmSync(dir, { recursive: true, force: true });
});

test("local browser requires local consent, pauses for takeover, and revokes on stop or target change", async () => {
  const userData = mkdtempSync(path.join(tmpdir(), "shiba-local-browser-e2e-"));
  userDataDirs.push(userData);
  const app = await electron.launch({
    chromiumSandbox: true,
    args: ["test/electron-bootstrap.cjs"],
    env: {
      ...(process.env as Record<string, string>),
      SHIBA_DESKTOP_URL: fixtureUrl,
      SHIBA_DESKTOP_TEST_USER_DATA: userData,
      SHIBA_LOCAL_RUN_ROOT: path.join(userData, "local"),
      SHELL: "",
    },
  });

  try {
    const dashboard = await app.firstWindow();
    await dashboard.waitForURL(`${fixtureUrl}/app/**`);
    expect(await dashboard.title()).toBe("Dashboard fixture");
    expect(await dashboard.evaluate(() => typeof (window as Window & { shibaLocalBrowser?: unknown }).shibaLocalBrowser)).toBe("undefined");

    const localWindowOpened = app.waitForEvent("window");
    await app.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById("open-local-browser");
      if (typeof item?.click !== "function") throw new Error("local browser menu action is missing");
      item.click();
    });
    const localBrowser = await localWindowOpened;
    await localBrowser.waitForURL(/local-browser\.html$/);
    expect(await localBrowser.evaluate(() => {
      const windowWithBridges = window as Window & { shibaDesktop?: unknown; shibaLocalBrowser?: unknown };
      return { local: typeof windowWithBridges.shibaLocalBrowser, dashboard: typeof windowWithBridges.shibaDesktop };
    })).toEqual({ local: "object", dashboard: "undefined" });
    await expect.poll(() => localBrowser.locator("#state-pill").textContent()).toBe("Stopped");

    await localBrowser.locator("#address").fill(fixtureUrl);
    await localBrowser.locator("#address-form").evaluate((form) => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await expect.poll(() => localBrowser.locator("#consent-origin").textContent()).toBe(fixtureUrl);
    await localBrowser.getByRole("button", { name: "Approve and open" }).click();
    await expect.poll(() => localBrowser.locator("#state-pill").textContent()).toBe("Approved");
    await expect.poll(() => siteBridgeChecks.length).toBe(1);
    expect(siteBridgeChecks[0]).toBe("undefined");
    expect(siteCookies[0]).not.toContain("session_marker=created");

    await expect.poll(() => localBrowser.evaluate(() => {
      const bridge = (window as Window & { shibaLocalBrowser?: { clickButton(label: string): Promise<unknown> } }).shibaLocalBrowser;
      return bridge?.clickButton("Disabled by fieldset");
    })).toEqual({ ok: true, clicked: false });

    await localBrowser.locator("#button-label").fill("Increase counter");
    await localBrowser.getByRole("button", { name: "Click button" }).click();
    await expect.poll(() => actionCount).toBe(1);
    expect(actionCookies[0]).toContain("session_marker=created");

    await localBrowser.getByRole("button", { name: "Take over" }).click();
    await expect.poll(() => localBrowser.locator("#state-pill").textContent()).toBe("Taken over");
    await expect.poll(() => localBrowser.getByRole("button", { name: "Click button" }).isDisabled()).toBe(true);
    expect(actionCount).toBe(1);
    await localBrowser.getByRole("button", { name: "Hand back to Shiba" }).click();
    await expect.poll(() => localBrowser.locator("#state-pill").textContent()).toBe("Approved");
    await localBrowser.getByRole("button", { name: "Click button" }).click();
    await expect.poll(() => actionCount).toBe(2);

    await localBrowser.getByRole("button", { name: "Stop" }).click();
    await expect.poll(() => localBrowser.locator("#state-pill").textContent()).toBe("Stopped");
    await expect.poll(() => localBrowser.locator("#controls").isHidden()).toBe(true);

    await localBrowser.locator("#address").fill(otherUrl);
    await localBrowser.locator("#address-form").evaluate((form) => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await expect.poll(() => localBrowser.locator("#consent-origin").textContent()).toBe(otherUrl);
    await localBrowser.getByRole("button", { name: "Approve and open" }).click();
    await expect.poll(() => localBrowser.locator("#state-pill").textContent()).toBe("Approved");
    expect(siteCookies[1] ?? "").not.toContain("session_marker=created");

    await localBrowser.getByRole("button", { name: "Stop" }).click();
    await expect.poll(() => localBrowser.locator("#state-pill").textContent()).toBe("Stopped");
    await localBrowser.locator("#address").fill(`${fixtureUrl}/hang`);
    await localBrowser.locator("#address-form").evaluate((form) => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await localBrowser.getByRole("button", { name: "Approve and open" }).click();
    await expect.poll(() => localBrowser.locator("#state-pill").textContent()).toBe("Approved");
    await expect.poll(() => hangingRequests).toBe(1);
    await localBrowser.locator("#button-label").fill("Increase counter");
    await localBrowser.getByRole("button", { name: "Click button" }).click();
    await expect.poll(() => localBrowser.locator("#message").textContent()).toBe("Wait for the approved site to finish loading.");
    await localBrowser.getByRole("button", { name: "Take over" }).click();
    await expect.poll(() => localBrowser.locator("#state-pill").textContent()).toBe("Taken over");
    expect(actionCount).toBe(2);
    await localBrowser.getByRole("button", { name: "Stop" }).click();
    await expect.poll(() => localBrowser.locator("#state-pill").textContent()).toBe("Stopped");

    await localBrowser.locator("#address").fill("http://127.0.0.1:1");
    await localBrowser.locator("#address-form").evaluate((form) => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await localBrowser.getByRole("button", { name: "Approve and open" }).click();
    await expect.poll(() => localBrowser.locator("#state-pill").textContent()).toBe("Stopped");
    await localBrowser.locator("#address").fill(fixtureUrl);
    await localBrowser.locator("#address-form").evaluate((form) => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await localBrowser.getByRole("button", { name: "Approve and open" }).click();
    await expect.poll(() => localBrowser.locator("#state-pill").textContent()).toBe("Approved");
    await expect.poll(() => siteBridgeChecks.length).toBe(2);
    await expect.poll(() => localBrowser.locator("#native-status").textContent()).toContain("Native window control is unavailable");
  } finally {
    await app.close();
  }
});
