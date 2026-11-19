import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { MenuItemConstructorOptions, Rectangle } from "electron";
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
import { createDashboardTrust, createSetupTrust } from "./ipc-trust.js";
import { dashboardPath, resolveConfiguredOrigin } from "./launch.js";
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
// Packaged, setup.html/setup.js ship in app.asar.unpacked/dist (asarUnpack in
// electron-builder.yml): file:// can't see inside app.asar on modern Electron,
// so the page is loaded from its real path on disk. Dev keeps dist/.
const SETUP_DIR = app.isPackaged
  ? path.join(process.resourcesPath, "app.asar.unpacked", "dist")
  : __dirname;
const SETUP_FILE = path.join(SETUP_DIR, "setup.html");
const SETUP_URL = pathToFileURL(SETUP_FILE).href;

let config: DesktopConfig = {};
let sessionOrigin: string | undefined;
let mainWindow: BrowserWindow | null = null;
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
  void (controller?.stop() ?? Promise.resolve()).finally(() => {
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
    guardWebContents(contents, {
      configuredOrigin,
      authHosts,
      openExternal: (url) => void shell.openExternal(url),
      onDecision: (decision) => {
        if (decision !== "allow") logEvent({ event: "navigation", action: decision });
      },
    });
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
