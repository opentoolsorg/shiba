import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { IpcMainInvokeEvent, MenuItemConstructorOptions, Rectangle, Session, WebContents } from "electron";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  nativeImage,
  powerMonitor,
  screen,
  session,
  shell,
  systemPreferences,
  WebContentsView,
} from "electron";
import type { ApprovalsPoller } from "./approvals-poller.js";
import { createApprovalsPoller } from "./approvals-poller.js";
import { BRIDGE_VERSION, encodeHandshake, parseHandshake } from "./bridge-contract.js";
import { startClaudeLogin } from "./claude-login.js";
import type { Controller } from "./controller.js";
import { createController } from "./controller.js";
import { dashboardCspReportOnly } from "./csp.js";
import { parseDeepLink } from "./deep-link.js";
import { createIpcBounds } from "./ipc-guard.js";
import { createDashboardTrust, createLocalBrowserTrust, createSetupTrust } from "./ipc-trust.js";
import { LOCAL_BROWSER_CHANNELS } from "./local-browser-contract.js";
import { nativeWindowAvailability, parseLocalBrowserAddress } from "./local-browser-policy.js";
import { createLocalControlBoundary } from "./local-control.js";
import { HOSTED_ORIGIN, dashboardPath, resolveConfiguredOrigin } from "./launch.js";
import type { Logger } from "./logs.js";
import { createLogger } from "./logs.js";
import { DEFAULT_AUTH_HOSTS, isSafeAppPath, parseDeploymentUrl } from "./navigation.js";
import type { DesktopSupervisor } from "./pairing.js";
import { emitStatusChanged, registerDesktopIpc } from "./pairing.js";
import { handleDaemonMessage } from "./run-notify.js";
import type { Env } from "./shell-env.js";
import { captureShellEnv } from "./shell-env.js";
import { registerShellIpc } from "./shell-ipc.js";
import { forkDaemon, resolveDaemonPath, shouldConfirmQuit } from "./supervisor.js";
import { buildTrayMenu, createTray } from "./tray.js";
import { guardWebContents } from "./window-security.js";
import {
  mediaDetailsFromHandler,
  shouldAllowSessionPermission,
} from "./session-permissions.js";
import { startUpdater } from "./updater.js";

interface DesktopConfig {
  deploymentUrl?: string;
  notifications?: boolean;
  startAtLogin?: boolean;
  authHosts?: string[];
  bounds?: Rectangle;
}

const isMac = process.platform === "darwin";
// userData/logs land in ~/Library/Application Support/<name> — the packaged
// package.json keeps the scoped name, so pin the product name (docs promise
// ~/Library/Application Support/Shiba).
app.setName("Shiba");
// Packaged setup and local-browser pages ship in app.asar.unpacked/dist (asarUnpack in
// electron-builder.yml): file:// can't see inside app.asar on modern Electron,
// so the page is loaded from its real path on disk. Dev keeps dist/.
const SETUP_DIR = app.isPackaged
  ? path.join(process.resourcesPath, "app.asar.unpacked", "dist")
  : __dirname;
const SETUP_FILE = path.join(SETUP_DIR, "setup.html");
const SETUP_URL = pathToFileURL(SETUP_FILE).href;
const LOCAL_BROWSER_FILE = path.join(SETUP_DIR, "local-browser.html");
const LOCAL_BROWSER_URL = pathToFileURL(LOCAL_BROWSER_FILE).href;

let config: DesktopConfig = {};
let sessionOrigin: string | undefined;
let mainWindow: BrowserWindow | null = null;
let localBrowserWindow: BrowserWindow | null = null;
let localBrowserView: WebContentsView | null = null;
let localBrowserSession: Session | null = null;
let localActionQueue: Promise<unknown> = Promise.resolve();
let localBrowserLifecycleQueue: Promise<unknown> = Promise.resolve();
let quitting = false;
let saveTimer: NodeJS.Timeout | undefined;
let controller: Controller | null = null;
let poller: ApprovalsPoller | null = null;
let tray: ReturnType<typeof createTray> | null = null;
let mainLog: Logger | null = null;
let daemonLog: Logger | null = null;
let shellEnv: Env = {};
let runRoot = path.join(os.homedir(), ".shiba-local");
let shutdownStarted = false;
let desktopActions: ReturnType<typeof registerDesktopIpc> | null = null;
const pendingLinks: string[] = process.argv.filter((arg) => arg.startsWith("shiba:"));

const logEvent = (fields: Parameters<NonNullable<Logger["event"]>>[0]) => mainLog?.event(fields);
/** One bridge-wide concurrency ceiling; pairing and shell handlers share it. */
const bounds = createIpcBounds();
const localControl = createLocalControlBoundary();
const nativeWindowStatus = nativeWindowAvailability({
  platform: process.platform,
  display: process.env.DISPLAY,
  waylandDisplay: process.env.WAYLAND_DISPLAY,
  sessionType: process.env.XDG_SESSION_TYPE,
});
const configPath = () => path.join(app.getPath("userData"), "config.json");

function loadConfig(): DesktopConfig {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8")) as DesktopConfig;
  } catch {
    return {};
  }
}

function saveConfig(patch: Partial<DesktopConfig>): void {
  config = { ...config, ...patch };
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  const tmp = `${configPath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, configPath());
}

/** Dev URL override, then a saved self-hosted origin, then https://app.tryshiba.dev. */
function configuredOrigin(): string {
  return resolveConfiguredOrigin({
    packaged: app.isPackaged,
    sessionUrl: sessionOrigin,
    envUrl: process.env.SHIBA_DESKTOP_URL,
    forceSetup: !app.isPackaged && process.env.SHIBA_DESKTOP_SETUP === "1",
    savedUrl: config.deploymentUrl,
    parse: parseDeploymentUrl,
  });
}

const authHosts = () => config.authHosts ?? DEFAULT_AUTH_HOSTS;

function restoredBounds(): Rectangle | undefined {
  const b = config.bounds;
  if (!b) return undefined;
  const visible = screen
    .getAllDisplays()
    .some(
      ({ workArea: w }) =>
        b.x < w.x + w.width && b.x + b.width > w.x && b.y < w.y + w.height && b.y + b.height > w.y,
    );
  return visible ? b : undefined;
}

function loadSetup(error?: string): void {
  if (!mainWindow) return;
  // loadFile resolves asar paths (packaged setup.html lives inside app.asar);
  // loadURL("file://…asar/…") hits the raw file loader and 404s. The gate
  // compares pathname only, so the query string stays equivalent.
  const params = new URLSearchParams();
  if (error) params.set("error", error);
  const origin = configuredOrigin();
  if (origin) params.set("url", origin);
  // The page offers the hosted product by name; the origin stays defined here.
  params.set("hosted", HOSTED_ORIGIN);
  const query = params.toString();
  void mainWindow.loadURL(`${SETUP_URL}${query ? `?${query}` : ""}`);
}

function loadDashboard(): void {
  const origin = configuredOrigin();
  if (!origin) {
    loadSetup();
    return;
  }
  void mainWindow?.loadURL(`${origin}/app/`);
}

/**
 * Load-failure UX for one window. Navigation, popup, and webview policy come
 * from the app-wide web-contents-created hook, so a window never carries two
 * copies of the gate (which would hand one link to the browser twice).
 */
function attachLoadFailure(win: BrowserWindow): void {
  win.webContents.on("did-fail-load", (_e, code, _description, validatedUrl, isMainFrame) => {
    // -3 = ERR_ABORTED (superseded navigation), not a real failure.
    if (!isMainFrame || code === -3) return;
    const origin = configuredOrigin();
    if (origin && validatedUrl.startsWith(origin)) {
      // Persistent diagnostics carry no free-form input: the numeric code is the
      // record, and the page shows fixed copy plus that code.
      logEvent({ event: "load-failed", code, url: origin });
      // Recovery keeps the saved URL and shows the address form with the code,
      // so a retry is one Continue away and nothing is silently forgotten.
      loadSetup(`Could not load ${origin} (error ${code}). Check the address and try again.`);
    }
  });
}

/**
 * The handshake the preload will accept, or nothing. A window created while no
 * deployment is configured gets no bridge at all, which is what the setup page
 * expects; anything the contract rejects fails closed the same way.
 */
function bridgeArguments(): string[] {
  const encoded = encodeHandshake({
    origin: configuredOrigin(),
    bridgeVersion: BRIDGE_VERSION,
    appVersion: app.getVersion(),
    platform: process.platform,
    surface: "dashboard",
  });
  return parseHandshake([encoded]) ? [encoded] : [];
}

function saveBoundsSoon(win: BrowserWindow): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!win.isDestroyed() && !win.isMinimized() && !win.isFullScreen())
      saveConfig({ bounds: win.getBounds() });
  }, 500);
}

function localBrowserUiState() {
  return { control: localControl.getState(), nativeWindow: nativeWindowStatus };
}

function publishLocalBrowserState(): void {
  if (localBrowserWindow && !localBrowserWindow.isDestroyed()) {
    localBrowserWindow.webContents.send(LOCAL_BROWSER_CHANNELS.stateChanged, localBrowserUiState());
  }
}

localControl.subscribe(publishLocalBrowserState);

function layoutLocalBrowserView(): void {
  if (!localBrowserWindow || !localBrowserView || localBrowserWindow.isDestroyed()) return;
  const { width, height } = localBrowserWindow.getContentBounds();
  const chromeHeight = 228;
  localBrowserView.setBounds({
    x: 0,
    y: chromeHeight,
    width: Math.max(0, width),
    height: Math.max(0, height - chromeHeight),
  });
}

async function disposeLocalBrowserView(owner = localBrowserWindow): Promise<void> {
  const view = localBrowserView;
  const browserSession = localBrowserSession;
  localBrowserView = null;
  localBrowserSession = null;
  if (view) {
    try {
      owner?.contentView.removeChildView(view);
    } catch {
      // The window may already be closing; the session cleanup still runs.
    }
    try {
      if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
    } catch {
      // Destroyed renderers are already unable to act.
    }
  }
  if (browserSession) {
    await Promise.allSettled([
      browserSession.clearStorageData(),
      browserSession.clearCache(),
      browserSession.clearAuthCache(),
    ]);
  }
}

async function stopLocalBrowserNow(reason: "user-stopped" | "target-changed" | "window-closed" | "unsupported" = "user-stopped") {
  localControl.stop(reason);
  await disposeLocalBrowserView();
  return localBrowserUiState();
}

function enqueueLocalBrowserLifecycle<T>(operation: () => Promise<T>): Promise<T> {
  const queued = localBrowserLifecycleQueue.then(operation);
  localBrowserLifecycleQueue = queued.catch(() => undefined);
  return queued;
}

function stopLocalBrowser(reason: "user-stopped" | "target-changed" | "window-closed" | "unsupported" = "user-stopped") {
  return enqueueLocalBrowserLifecycle(() => stopLocalBrowserNow(reason));
}

function guardLocalBrowserNavigation(contents: WebContents, approvedOrigin: string): void {
  const refuse = (event: { preventDefault(): void }, rawUrl: string, isMainFrame: boolean) => {
    const target = parseLocalBrowserAddress(rawUrl);
    if (target && target.origin === approvedOrigin) return;
    event.preventDefault();
    if (isMainFrame) void stopLocalBrowser("target-changed");
  };

  contents.on("will-navigate", (event, url) => refuse(event, url, true));
  contents.on("will-redirect", (event, url, _isInPlace, isMainFrame) => refuse(event, url, isMainFrame));
  contents.on("will-frame-navigate", (event) => {
    if (event.isMainFrame) return;
    refuse(event, event.url, false);
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("login", (event) => event.preventDefault());
  contents.on("render-process-gone", () => void stopLocalBrowser("window-closed"));
}

function configureLocalBrowserSession(browserSession: Session, approvedOrigin: string): void {
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  browserSession.setPermissionCheckHandler(() => false);
  browserSession.on("will-download", (event, item) => {
    event.preventDefault();
    item.cancel();
  });
  browserSession.webRequest.onBeforeRequest(
    { urls: ["<all_urls>"] },
    (details, callback) => {
      const request = parseLocalBrowserAddress(details.url);
      callback({ cancel: !request || request.origin !== approvedOrigin });
    },
  );
}

async function approveLocalBrowserSiteNow(rawUrl: unknown): Promise<{ ok: boolean; error?: string; origin?: string }> {
  const address = parseLocalBrowserAddress(rawUrl);
  if (!address) return { ok: false, error: "Use an http or https address without embedded credentials." };
  const owner = localBrowserWindow;
  if (!owner || owner.isDestroyed()) return { ok: false, error: "Open the local browser from the Shiba Desktop menu first." };

  localControl.stop("user-stopped");
  await disposeLocalBrowserView(owner);
  localControl.approve({ kind: "browser", origin: address.origin });

  // Reuse one context and clear it on every stop/approval; creating a new
  // partition per approval leaves native Chromium contexts alive until quit.
  const browserSession = session.fromPartition("shiba-local-browser", { cache: false });
  localBrowserSession = browserSession;
  let view: WebContentsView;
  try {
    configureLocalBrowserSession(browserSession, address.origin);
    view = new WebContentsView({
      webPreferences: {
        session: browserSession,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      disableBlinkFeatures: "PeerConnection",
      },
    });
  } catch {
    localControl.stop("unsupported");
    await disposeLocalBrowserView(owner);
    return { ok: false, error: "This local browser could not be started safely." };
  }
  localBrowserView = view;
  try {
    owner.contentView.addChildView(view);
    layoutLocalBrowserView();
    guardLocalBrowserNavigation(view.webContents, address.origin);
  } catch {
    await stopLocalBrowserNow("unsupported");
    return { ok: false, error: "This local browser could not be started safely." };
  }

  try {
    await view.webContents.loadURL(address.href);
    return { ok: true, origin: address.origin };
  } catch {
    await stopLocalBrowser("target-changed");
    return { ok: false, error: "The approved site could not be opened." };
  }
}

function approveLocalBrowserSite(rawUrl: unknown) {
  return enqueueLocalBrowserLifecycle(() => approveLocalBrowserSiteNow(rawUrl));
}

async function navigateLocalBrowser(rawUrl: unknown): Promise<{ ok: boolean; error?: string; origin?: string }> {
  const address = parseLocalBrowserAddress(rawUrl);
  if (!address) return { ok: false, error: "Use an http or https address without embedded credentials." };
  const state = localControl.getState();
  if (state.phase !== "approved" || state.target.kind !== "browser" || !localBrowserView) {
    return { ok: false, error: "Approve a site in this local window first." };
  }
  if (address.origin !== state.target.origin) {
    localControl.targetChanged({ kind: "browser", origin: address.origin });
    await disposeLocalBrowserView();
    return { ok: false, error: "The site changed; approval was revoked.", origin: address.origin };
  }
  try {
    await localBrowserView.webContents.loadURL(address.href);
    return { ok: true, origin: address.origin };
  } catch {
    return { ok: false, error: "The approved site could not be opened." };
  }
}

async function clickLocalBrowserButton(rawLabel: unknown): Promise<{ ok: boolean; clicked?: boolean; error?: string }> {
  const label = typeof rawLabel === "string" ? rawLabel.trim() : "";
  if (label.length === 0 || label.length > 100 || /[\u0000-\u001f\u007f]/.test(label)) {
    return { ok: false, error: "Enter an exact visible button label (up to 100 characters)." };
  }
  const state = localControl.getState();
  const target = state.phase === "approved" ? state.target : null;
  const view = localBrowserView;
  if (!target || target.kind !== "browser" || !view || !localControl.canControl(target)) {
    return { ok: false, error: "Shiba control is paused or stopped." };
  }
  const revision = state.revision;
  const action = localActionQueue.then(async () => {
    const current = localControl.getState();
    if (localBrowserView !== view || current.phase !== "approved" || current.revision !== revision ||
      current.mode !== "control" || current.target.kind !== "browser" || current.target.origin !== target.origin) {
      return { ok: false, error: "Control was revoked before the action started." };
    }
    const script = `(() => {
    const label = ${JSON.stringify(label)};
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return element.isConnected && element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
        rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 &&
        rect.left < innerWidth && rect.top < innerHeight && (top === element || element.contains(top));
    };
    const matches = [...document.querySelectorAll("button")].filter((button) =>
      !button.disabled && visible(button) && (button.innerText || button.getAttribute("aria-label") || "").trim() === label
    );
    if (matches.length !== 1) return false;
    matches[0].click();
    return true;
    })()`;
    try {
      const clicked = await view.webContents.executeJavaScript(script, true);
      const after = localControl.getState();
      if (localBrowserView !== view || after.phase !== "approved" || after.revision !== revision ||
        after.mode !== "control" || after.target.kind !== "browser" || after.target.origin !== target.origin) {
        return { ok: false, error: "Control was revoked before the action completed." };
      }
      return { ok: true, clicked: clicked === true };
    } catch {
      return { ok: false, error: "The visible action could not be completed." };
    }
  });
  localActionQueue = action.catch(() => undefined);
  return action;
}

function openLocalBrowser(): void {
  if (localBrowserWindow && !localBrowserWindow.isDestroyed()) {
    localBrowserWindow.show();
    localBrowserWindow.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 1120,
    height: 820,
    minWidth: 760,
    minHeight: 560,
    show: false,
    title: "Shiba Local Browser",
    webPreferences: {
      preload: path.join(__dirname, "local-browser-preload.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  });
  localBrowserWindow = win;
  win.once("ready-to-show", () => win.show());
  win.on("resize", layoutLocalBrowserView);
  win.on("closed", () => {
    if (localBrowserWindow === win) localBrowserWindow = null;
    localControl.stop("window-closed");
    void disposeLocalBrowserView(win);
  });
  void win.loadURL(LOCAL_BROWSER_URL);
}

function createWindow(): void {
  const bounds = restoredBounds();
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    ...bounds,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      // preload reads this; the page can't influence it (D4).
      additionalArguments: bridgeArguments(),
    },
  });
  mainWindow = win;
  attachLoadFailure(win);
  win.once("ready-to-show", () => win.show());
  // Sign-in finishes with a navigation; re-probe then instead of waiting for the 60s timer.
  win.webContents.on("did-navigate", () => {
    if (controller?.status().state === "signed-out") void controller.probe();
  });
  win.on("resize", () => saveBoundsSoon(win));
  win.on("move", () => saveBoundsSoon(win));
  win.on("close", (event) => {
    if (!win.isDestroyed()) saveConfig({ bounds: win.getBounds() });
    // macOS keeps the app alive; only an explicit quit closes the window.
    if (isMac && !quitting) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  loadDashboard();
}

function handleDeepLink(raw: string): void {
  if (!mainWindow) {
    pendingLinks.push(raw);
    return;
  }
  const link = parseDeepLink(raw);
  if (!link) return;
  if (link.kind === "view") openPath(dashboardPath(link.view));
  else void shell.openExternal(link.url);
}

function flushDeepLinks(): void {
  for (const raw of pendingLinks.splice(0)) handleDeepLink(raw);
}

function showWindow(): void {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** Window is rebuilt because the preload origin is fixed at creation. */
function recreateWindow(): void {
  const old = mainWindow;
  mainWindow = null;
  createWindow();
  old?.destroy();
}

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: "appMenu" } as MenuItemConstructorOptions] : []),
    {
      label: "File",
      submenu: [
        {
          label: "Open Local Browser",
          id: "open-local-browser",
          click: openLocalBrowser,
        },
        { type: "separator" },
        {
          label: "Change Shiba URL…",
          click: () => {
            showWindow();
            loadSetup();
          },
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function ensureMicrophoneAccess(): Promise<boolean> {
  if (!isMac) return true;
  if (systemPreferences.getMediaAccessStatus("microphone") === "granted") return true;
  return systemPreferences.askForMediaAccess("microphone");
}

/** Installed on the default session before the first window loads a page. */
function configurePermissions(): void {
  const evaluate = (permission: string, requestUrl: string, details?: unknown) =>
    shouldAllowSessionPermission(
      permission,
      requestUrl,
      configuredOrigin(),
      mediaDetailsFromHandler(permission, details),
    );

  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const requestUrl =
      details && typeof details === "object" && "requestingUrl" in details
        ? String((details as { requestingUrl?: string }).requestingUrl ?? "")
        : wc.getURL();
    const grant = evaluate(permission, requestUrl || wc.getURL(), details);
    if (!grant) {
      callback(false);
      return;
    }
    if (permission === "media") {
      void ensureMicrophoneAccess().then(callback);
      return;
    }
    callback(true);
  });
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
    const requestingUrl =
      details && typeof details === "object" && "requestingUrl" in details
        ? (details as { requestingUrl?: string }).requestingUrl
        : undefined;
    return evaluate(
      permission,
      requestingOrigin || requestingUrl || wc?.getURL() || "",
      details,
    );
  });
}

/** Adds the shell's Report-Only dashboard policy only when the Worker sent none. */
function installCspReportOnly(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const policy = dashboardCspReportOnly({
      url: details.url,
      resourceType: details.resourceType,
      headers: details.responseHeaders ?? {},
      configuredOrigin: configuredOrigin(),
    });
    if (!policy) {
      callback({});
      return;
    }
    callback({
      responseHeaders: {
        ...(details.responseHeaders ?? {}),
        "Content-Security-Policy-Report-Only": [policy],
      },
    });
  });
}

const sessionFetch = (url: string, init?: RequestInit) =>
  // Timeout: a hung probe would leave the controller's probing flag set forever.
  session.defaultSession.fetch(url, {
    credentials: "include",
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
    ...init,
  });

function appIconPath(): string | null {
  const icon = path.join(app.getAppPath(), "assets", "icon.png");
  return fs.existsSync(icon) ? icon : null;
}

function notify(n: { title: string; body: string }, onClick: () => void): void {
  if (config.notifications === false || !Notification.isSupported()) return;
  // Windows and Linux take the notification icon from the payload; macOS uses the app icon.
  const icon = process.platform === "darwin" ? null : appIconPath();
  const notification = new Notification({ title: n.title, body: n.body, ...(icon ? { icon } : {}) });
  notification.on("click", onClick);
  notification.show();
}

/** Loads an absolute dashboard URL only when it is ours and on a known path. */
function loadAppUrl(url: string): void {
  const origin = configuredOrigin();
  if (!origin || !url.startsWith(`${origin}/`)) {
    // A deep link or notification click is caller-supplied text: the event name
    // is the record, and the refused string is never written anywhere.
    logEvent({ event: "app-url-refused" });
    return;
  }
  openPath(url.slice(origin.length));
}

/** Loads an app-internal path; a native caller can only reach a known tab. */
function openPath(pathAndQuery: string): boolean {
  if (!isSafeAppPath(pathAndQuery)) {
    logEvent({ event: "app-path-refused" });
    return false;
  }
  const origin = configuredOrigin();
  if (!origin) {
    loadSetup();
    return false;
  }
  showWindow();
  void mainWindow?.loadURL(`${origin}${pathAndQuery}`);
  return true;
}

function buildPoller(): void {
  poller?.stop();
  const origin = configuredOrigin();
  poller = origin
    ? createApprovalsPoller({
        fetch: (url) => sessionFetch(url),
        approvalsUrl: `${origin}/api/approvals`,
        openUrl: `${origin}/app/?tab=approvals`,
        showWindow,
        loadURL: loadAppUrl,
        notify,
        onError: () => logEvent({ event: "approvals-poll", state: "failed" }),
      })
    : null;
}

function refreshTray(): void {
  if (!controller) return;
  tray?.update(
    buildTrayMenu(controller.status(), {
      notifications: config.notifications !== false,
      startAtLogin: config.startAtLogin !== false,
    }),
  );
}

function onStatus(status: Parameters<typeof emitStatusChanged>[1]): void {
  emitStatusChanged(mainWindow?.webContents, status);
  refreshTray();
  // The approvals poller has its own probe (§3.4), so it just retries whenever the daemon state moves.
  if (status.state !== "signed-out" && config.notifications !== false) void poller?.start();
}

/** Native actions share pairing's origin checks and single-flight operation. */
async function disconnectLocal(): Promise<void> {
  try {
    const result = await desktopActions?.unpair();
    if (result && !result.ok) {
      logEvent({ event: "unpair", state: result.code });
      // Fixed copy: the code is logged, the page owns the per-code wording.
      await dialog.showMessageBox({
        type: "info",
        message: "Could not disconnect this computer.",
        detail: "Check the connection and retry from the dashboard.",
        buttons: ["OK"],
      });
    }
  } catch {
    logEvent({ event: "disconnect", state: "failed" });
  }
}

async function checkForUpdates(): Promise<unknown> {
  const mod = await import("electron-updater");
  // electron-updater is CJS; under ESM interop the real exports land on
  // .default (autoUpdater isn't statically detectable as a named export).
  const resolved = (mod as unknown as { default?: typeof mod }).default ?? mod;
  const { autoUpdater } = resolved;
  return autoUpdater.checkForUpdatesAndNotify();
}

function onTraySelect(id: string): void {
  switch (id) {
    case "open":
      openPath("/app/");
      return;
    case "approvals":
      openPath("/app/?tab=approvals");
      return;
    case "connect":
      openPath("/app/?tab=remote");
      return;
    case "disconnect":
      return void disconnectLocal();
    case "retry":
      return void controller?.retry();
    case "notifications": {
      saveConfig({ notifications: config.notifications === false });
      if (config.notifications === false) poller?.stop();
      else void poller?.start();
      refreshTray();
      return;
    }
    case "start-at-login": {
      saveConfig({ startAtLogin: config.startAtLogin === false });
      applyLoginItem();
      refreshTray();
      return;
    }
    case "change-url":
      showWindow();
      loadSetup();
      return;
    case "logs":
      return void shell.openPath(path.join(app.getPath("userData"), "logs"));
    case "updates":
      return void checkForUpdates().catch(() => logEvent({ event: "update-check", state: "failed" }));
    case "quit":
      app.quit();
      return;
  }
}

function applyLoginItem(): void {
  // openAsHidden is gone from Electron 44 types; dev runs must not register the unpackaged binary.
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: config.startAtLogin !== false });
}

function trayIconPath(): string | null {
  // assets/ ships inside app.asar via electron-builder "files"; getAppPath()
  // returns the asar root packaged and the package dir in dev. Electron's fs
  // reads asar paths transparently, so one path works in both modes.
  // macOS recolours a template silhouette; Windows and Linux need the colour mark.
  const base = app.getAppPath();
  const icon = path.join(base, "assets", process.platform === "darwin" ? "trayTemplate.png" : "tray.png");
  return fs.existsSync(icon) ? icon : null;
}

function setDockIcon(): void {
  if (!isMac || !app.dock) return;
  const iconPath = appIconPath();
  if (!iconPath) return;
  const icon = nativeImage.createFromBuffer(fs.readFileSync(iconPath));
  if (!icon.isEmpty()) app.dock.setIcon(icon);
}

const supervisorFacade: DesktopSupervisor = {
  status: () => controller?.status() ?? { state: "signed-out" },
  stop: async () => {
    await controller?.stop();
    controller?.setStatus({ state: "unpaired" });
  },
  probe: () => controller?.probe(),
};

/** The shell's own window contents; anything else is a foreign webContents. */
const ownedContents = () => mainWindow?.webContents ?? null;

// Native pairing is deferred: the Worker mints tokens for the same authorized
// operator session this window already holds, so the shell has nothing to add
// and mints nothing. The browser flow (Add computer) stays the supported path.

function registerIpc(): void {
  const isTrustedEvent = createDashboardTrust({ configuredOrigin, ownedContents });
  const isSetupEvent = createSetupTrust({
    setupFileUrl: SETUP_URL,
    ownedContents,
  });
  const isLocalBrowserEvent = createLocalBrowserTrust({
    localBrowserFileUrl: LOCAL_BROWSER_URL,
    ownedContents: () => localBrowserWindow?.webContents ?? null,
  });
  desktopActions = registerDesktopIpc({
    ipcMain,
    isTrustedEvent,
    isSetupEvent,
    parseDeploymentUrl: (input) => parseDeploymentUrl(input, app.isPackaged),
    onSetUrl: (origin) => {
      saveConfig({ deploymentUrl: origin });
      sessionOrigin = origin;
      recreateWindow();
      buildPoller();
      // probe only after stop settles, or it sees the dying child and never restarts.
      void controller?.stop().then(() => controller?.probe());
    },
    supervisor: supervisorFacade,
    getConfiguredOrigin: configuredOrigin,
    sessionFetch,
    get runRoot() {
      return runRoot;
    },
    readLocalConfig,
    event: (fields) => logEvent(fields),
    bounds,
  });
  registerShellIpc({
    ipcMain,
    isTrustedEvent,
    bounds,
    startClaudeLogin: () => startClaudeLogin({ env: shellEnv }),
  });

  const trustedLocalCall = (event: IpcMainInvokeEvent) => isLocalBrowserEvent(event);
  ipcMain.handle(LOCAL_BROWSER_CHANNELS.getState, (event) =>
    trustedLocalCall(event) ? localBrowserUiState() : {
      control: { phase: "stopped", revision: 0, reason: "not-started" },
      nativeWindow: nativeWindowStatus,
    },
  );
  ipcMain.handle(LOCAL_BROWSER_CHANNELS.approve, (event, url: unknown) =>
    trustedLocalCall(event) ? approveLocalBrowserSite(url) : { ok: false, error: "Untrusted sender." },
  );
  ipcMain.handle(LOCAL_BROWSER_CHANNELS.navigate, (event, url: unknown) =>
    trustedLocalCall(event) ? navigateLocalBrowser(url) : { ok: false, error: "Untrusted sender." },
  );
  ipcMain.handle(LOCAL_BROWSER_CHANNELS.clickButton, (event, label: unknown) =>
    trustedLocalCall(event) ? clickLocalBrowserButton(label) : { ok: false, error: "Untrusted sender." },
  );
  ipcMain.handle(LOCAL_BROWSER_CHANNELS.takeOver, (event) => {
    if (!trustedLocalCall(event)) return { control: { phase: "stopped", revision: 0, reason: "not-started" }, nativeWindow: nativeWindowStatus };
    localControl.takeOver();
    return localBrowserUiState();
  });
  ipcMain.handle(LOCAL_BROWSER_CHANNELS.handBack, (event) => {
    if (!trustedLocalCall(event)) return { control: { phase: "stopped", revision: 0, reason: "not-started" }, nativeWindow: nativeWindowStatus };
    localControl.handBack();
    return localBrowserUiState();
  });
  ipcMain.handle(LOCAL_BROWSER_CHANNELS.stop, (event) =>
    trustedLocalCall(event) ? stopLocalBrowser("user-stopped") : { control: { phase: "stopped", revision: 0, reason: "not-started" }, nativeWindow: nativeWindowStatus },
  );
}

// Reads the daemon's config.json so revoke still has a machineId when the live
// status dropped it (conflict/crashed). Shared by the controller probe, the
// tray Disconnect path, and the desktop:unpair IPC handler.
function readLocalConfig(): { workerUrl?: string; machineId?: string } | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(runRoot, "config.json"), "utf8"));
  } catch {
    return null;
  }
}

function initController(): void {
  const daemonPath = resolveDaemonPath({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    repoRoot: path.resolve(__dirname, "..", "..", ".."),
  });
  controller = createController({
    getOrigin: configuredOrigin,
    probeFetch: (url) => sessionFetch(url),
    readLocalConfig,
    fork: (args, hooks) => forkDaemon({ daemonPath, args, env: shellEnv, ...hooks }),
    onStatus,
    onSettled: (msg) =>
      handleDaemonMessage(msg, {
        origin: configuredOrigin(),
        showWindow,
        loadURL: loadAppUrl,
        notify,
      }),
    // Daemon output is counted, never logged: a chunk can carry a URL, a repo
    // name, or a token, and none of that belongs in a file.
    event: (fields) => daemonLog?.event(fields),
  });
}

async function initIntegrations(): Promise<void> {
  const logsDir = path.join(app.getPath("userData"), "logs");
  mainLog = createLogger(logsDir, "main.log");
  daemonLog = createLogger(logsDir, "daemon.log");
  shellEnv = await captureShellEnv();
  runRoot = shellEnv.SHIBA_LOCAL_RUN_ROOT || path.join(os.homedir(), ".shiba-local");
  initController();
  buildPoller();
  const icon = trayIconPath();
  if (icon) tray = createTray(icon, onTraySelect);
  else logEvent({ event: "tray", state: "missing" });
  refreshTray();
  applyLoginItem();
  startUpdater({
    isPackaged: app.isPackaged,
    checkForUpdatesAndNotify: checkForUpdates,
    onError: () => logEvent({ event: "update-check", state: "failed" }),
  });
  powerMonitor.on("suspend", () => poller?.stop());
  powerMonitor.on("resume", () => {
    void controller?.probe();
    if (config.notifications !== false) void poller?.start();
  });
  await controller?.probe();
}

/** Quit stops the daemon first; a mid-run quit asks, since the run gets reported failed. */
function onBeforeQuit(event: Electron.Event): void {
  if (shutdownStarted) return;
  event.preventDefault();
  if (controller && shouldConfirmQuit(controller.status().state)) {
    const choice = dialog.showMessageBoxSync({
      type: "warning",
      message: "A local run is in progress.",
      detail: "Quitting stops it and reports it failed.",
      buttons: ["Quit", "Cancel"],
      defaultId: 1,
      cancelId: 1,
    });
    if (choice !== 0) return;
  }
  shutdownStarted = true;
  quitting = true;
  poller?.stop();
  void Promise.all([
    controller?.stop() ?? Promise.resolve(),
    stopLocalBrowser("user-stopped"),
  ]).finally(() => {
    controller?.dispose();
    tray?.destroy();
    // Finish Electron's normal shutdown so renderer storage and session cookies
    // are flushed. app.exit() can discard a just-written unsent draft.
    app.quit();
  });
}

function registerProtocol(): void {
  if (!app.isPackaged) return;
  try {
    app.setAsDefaultProtocolClient("shiba");
  } catch {
    logEvent({ event: "protocol-register", state: "failed" });
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const link = argv.find((arg) => arg.startsWith("shiba:"));
    if (link) handleDeepLink(link);
    else showWindow();
  });
  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });
  app.on("before-quit", onBeforeQuit);
  app.on("activate", showWindow);
  app.on("window-all-closed", () => {
    if (!isMac) app.quit();
  });
  // Every window webContents gets the same policy, including any the app opens later.
  app.on("web-contents-created", (_event, contents) => {
    if (contents.getType() !== "window") return;
    if (contents.session === localBrowserSession) return;
    guardWebContents(contents, {
      configuredOrigin,
      authHosts,
      openExternal: (url) => void shell.openExternal(url),
      onDecision: (decision) => {
        if (decision !== "allow") logEvent({ event: "navigation", action: decision });
      },
    }, { allowFileUrls: [SETUP_URL, LOCAL_BROWSER_URL] });
  });
  void app.whenReady().then(() => {
    setDockIcon();
    config = loadConfig();
    registerProtocol();
    buildMenu();
    registerIpc();
    // Deny-by-default permissions and the report-only CSP must exist before the
    // first page loads, or the first request races the policy.
    configurePermissions();
    installCspReportOnly();
    createWindow();
    flushDeepLinks();
    void initIntegrations();
  });
}
