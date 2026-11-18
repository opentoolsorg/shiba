import { contextBridge, ipcRenderer } from "electron";

// Origin and versions come from BrowserWindow additionalArguments, never from
// the page (D4). A sandboxed preload cannot require a shared module, so the
// channel names below are literals that test/bridge-contract.test.ts pins to
// apps/desktop/src/bridge-contract.ts.
const HANDSHAKE_PREFIX = "--shiba-bridge=";
const BRIDGE_VERSION = 1;
const DESKTOP_CAPABILITIES = ["status", "pair", "unpair", "onStatus", "claudeLogin"];

type Handshake = {
  origin: string;
  bridgeVersion: number;
  appVersion: string;
  platform: string;
};

function readHandshake(): Handshake | null {
  const raw = process.argv.find((arg) => arg.startsWith(HANDSHAKE_PREFIX));
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(HANDSHAKE_PREFIX.length));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const value = parsed as Partial<Handshake>;
  if (typeof value.origin !== "string" || value.origin.length === 0) return null;
  if (value.bridgeVersion !== BRIDGE_VERSION) return null;
  if (typeof value.appVersion !== "string" || value.appVersion.length > 64) return null;
  if (typeof value.platform !== "string" || value.platform.length > 32) return null;
  return {
    origin: value.origin,
    bridgeVersion: value.bridgeVersion,
    appVersion: value.appVersion,
    platform: value.platform,
  };
}

const handshake = readHandshake();

if (handshake && location.origin === handshake.origin) {
  contextBridge.exposeInMainWorld("shibaDesktop", {
    bridgeVersion: handshake.bridgeVersion,
    appVersion: handshake.appVersion,
    platform: handshake.platform,
    capabilities: DESKTOP_CAPABILITIES,
    status: () => ipcRenderer.invoke("desktop:status"),
    pair: (pairingToken: string) => ipcRenderer.invoke("desktop:pair", pairingToken),
    unpair: () => ipcRenderer.invoke("desktop:unpair"),
    onStatus: (listener: (status: unknown) => void) => {
      const handler = (_e: unknown, status: unknown) => listener(status);
      ipcRenderer.on("desktop:status-changed", handler);
      return () => {
        ipcRenderer.removeListener("desktop:status-changed", handler);
      };
    },
    startClaudeLogin: () => ipcRenderer.invoke("desktop:claude-login"),
  });
} else if (location.protocol === "file:" && location.pathname.endsWith("/setup.html")) {
  // Setup page only; main re-checks the sender frame in the handler.
  contextBridge.exposeInMainWorld("shibaSetup", {
    setUrl: (url: string) => ipcRenderer.invoke("desktop:set-url", url),
  });
}
