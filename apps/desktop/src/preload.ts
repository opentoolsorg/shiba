import { contextBridge, ipcRenderer } from "electron";

// Origin, versions, and surface come from BrowserWindow additionalArguments,
// never from the page (D4). A sandboxed preload cannot require a shared module,
// so the literals below are the contract test/bridge-contract.test.ts pins to
// apps/desktop/src/bridge-contract.ts.
const HANDSHAKE_PREFIX = "--shiba-bridge=";
const BRIDGE_VERSION = 1;
const DESKTOP_CAPABILITIES = ["status", "pair", "unpair", "onStatus", "claudeLogin"];
const SETUP_PAGE = /\/setup\.html$/;

type Surface = "dashboard" | "setup";

type Handshake = {
  origin: string;
  bridgeVersion: number;
  appVersion: string;
  platform: string;
  surface: Surface;
};

function absoluteOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function readHandshake(): Handshake | null {
  const matches = process.argv.filter((arg) => arg.startsWith(HANDSHAKE_PREFIX));
  // Exactly one handshake, or none: duplicates mean main sent something odd.
  if (matches.length !== 1) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(matches[0].slice(HANDSHAKE_PREFIX.length));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const value = parsed as Partial<Handshake>;
  const origin = absoluteOrigin(value.origin);
  if (!origin) return null;
  if (value.bridgeVersion !== BRIDGE_VERSION) return null;
  if (typeof value.appVersion !== "string" || value.appVersion.length === 0 || value.appVersion.length > 64)
    return null;
  if (typeof value.platform !== "string" || value.platform.length === 0 || value.platform.length > 32)
    return null;
  if (value.surface !== "dashboard" && value.surface !== "setup") return null;
  return {
    origin,
    bridgeVersion: value.bridgeVersion,
    appVersion: value.appVersion,
    platform: value.platform,
    surface: value.surface,
  };
}

const handshake = readHandshake();
const isSetupPage = location.protocol === "file:" && SETUP_PAGE.test(location.pathname);

if (handshake && !isSetupPage && location.origin === handshake.origin) {
  contextBridge.exposeInMainWorld("shibaDesktop", {
    bridgeVersion: handshake.bridgeVersion,
    appVersion: handshake.appVersion,
    platform: handshake.platform,
    surface: handshake.surface,
    capabilities: DESKTOP_CAPABILITIES,
    status: () => ipcRenderer.invoke("desktop:status"),
    // No token crosses the bridge: main mints it and hands it to the daemon.
    pair: () => ipcRenderer.invoke("desktop:pair"),
    unpair: () => ipcRenderer.invoke("desktop:unpair"),
    onStatus: (listener: (status: unknown) => void) => {
      const handler = (_e: unknown, status: unknown) => listener(status);
      ipcRenderer.on("desktop:status-changed", handler);
      return () => {
        ipcRenderer.removeListener("desktop:status-changed", handler);
      };
    },
    startClaudeLogin: () => ipcRenderer.invoke("desktop:claude-login"),
    // Compatibility: an older dashboard still calls this to receive a PKCE
    // callback. Nothing listens; main answers with a fixed refusal so the page
    // shows the browser instruction instead of a broken promise.
    receiveCodexCallback: (_authorizationUrl: string) =>
      ipcRenderer.invoke("desktop:codex-callback"),
  });
} else if (isSetupPage) {
  // Setup page only; main re-checks the sender window, frame, and page path.
  contextBridge.exposeInMainWorld("shibaSetup", {
    surface: "setup",
    setUrl: (url: string) => ipcRenderer.invoke("desktop:set-url", url),
  });
}
