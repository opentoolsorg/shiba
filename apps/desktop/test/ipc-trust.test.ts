import { describe, expect, it } from "vitest";
import { createDashboardTrust, createLocalBrowserTrust, createSetupTrust, type IpcSenderEvent } from "../src/ipc-trust.js";

const ORIGIN = "https://shiba.example.com";
const SETUP = "file:///Applications/Shiba.app/Contents/Resources/app/dist/setup.html";
const LOCAL_BROWSER = "file:///Applications/Shiba.app/Contents/Resources/app/dist/local-browser.html";

const ownWindow: { id: string; mainFrame?: { url: string } } = { id: "own" };
const otherWindow: { id: string; mainFrame?: { url: string } } = { id: "other" };

/** An invoke event as Electron delivers it: the sending frame and its window. */
function eventFrom(
  url: string,
  options: { window?: typeof ownWindow; mainFrame?: boolean } = {},
): IpcSenderEvent {
  const frame = { url };
  const sender = options.window ?? ownWindow;
  sender.mainFrame = frame;
  return {
    senderFrame: options.mainFrame === false ? { url: `${ORIGIN}/subframe` } : frame,
    sender: sender as unknown as IpcSenderEvent["sender"],
  };
}

const dashboard = createDashboardTrust({
  configuredOrigin: () => ORIGIN,
  ownedContents: () => ownWindow,
});
const setup = createSetupTrust({ setupFileUrl: SETUP, ownedContents: () => ownWindow });
const localBrowser = createLocalBrowserTrust({ localBrowserFileUrl: LOCAL_BROWSER, ownedContents: () => ownWindow });

describe("ipc trust", () => {
  it("accepts the shell's own window on its main frame at the configured origin", () => {
    expect(dashboard(eventFrom(`${ORIGIN}/app/`))).toBe(true);
  });

  it("refuses a subframe of the dashboard", () => {
    expect(dashboard(eventFrom(`${ORIGIN}/app/`, { mainFrame: false }))).toBe(false);
  });

  it("refuses another window even with a matching frame url", () => {
    expect(dashboard(eventFrom(`${ORIGIN}/app/`, { window: otherWindow }))).toBe(false);
  });

  it("refuses a foreign origin and a missing frame", () => {
    expect(dashboard(eventFrom("https://evil.example/app/"))).toBe(false);
    expect(dashboard({ senderFrame: null, sender: { mainFrame: null } })).toBe(false);
    expect(dashboard({ senderFrame: { url: `${ORIGIN}/app/` }, sender: null })).toBe(false);
    expect(
      dashboard({ senderFrame: { url: `${ORIGIN}/app/` }, sender: { mainFrame: null } }),
    ).toBe(false);
  });

  it("accepts only the setup page, from the own window's main frame", () => {
    expect(setup(eventFrom(SETUP))).toBe(true);
    expect(setup(eventFrom(SETUP, { mainFrame: false }))).toBe(false);
    expect(setup(eventFrom(SETUP, { window: otherWindow }))).toBe(false);
    expect(setup(eventFrom(`${ORIGIN}/dist/setup.html`))).toBe(false);
    expect(dashboard(eventFrom(SETUP))).toBe(false);
  });

  it("accepts local browser controls only from its own bundled main-frame page", () => {
    expect(localBrowser(eventFrom(LOCAL_BROWSER))).toBe(true);
    expect(localBrowser(eventFrom(`${LOCAL_BROWSER}?unexpected=1`))).toBe(true);
    expect(localBrowser(eventFrom(LOCAL_BROWSER, { mainFrame: false }))).toBe(false);
    expect(localBrowser(eventFrom(LOCAL_BROWSER, { window: otherWindow }))).toBe(false);
    expect(localBrowser(eventFrom("file:///tmp/local-browser.html"))).toBe(false);
    expect(localBrowser(eventFrom(`${ORIGIN}/app/`))).toBe(false);
  });

  it("follows the window the shell last created", () => {
    let current: unknown = ownWindow;
    const trust = createDashboardTrust({
      configuredOrigin: () => ORIGIN,
      ownedContents: () => current,
    });
    expect(trust(eventFrom(`${ORIGIN}/app/`))).toBe(true);
    current = otherWindow;
    expect(trust(eventFrom(`${ORIGIN}/app/`))).toBe(false);
    expect(trust(eventFrom(`${ORIGIN}/app/`, { window: otherWindow }))).toBe(true);
  });

  it("treats an unset origin as matching nothing", () => {
    const trust = createDashboardTrust({ configuredOrigin: () => "", ownedContents: () => ownWindow });
    expect(trust(eventFrom(`${ORIGIN}/app/`))).toBe(false);
  });
});
