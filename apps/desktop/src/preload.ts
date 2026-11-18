import { contextBridge, ipcRenderer } from "electron";

// Origin and metadata come from BrowserWindow additionalArguments, never from
// the page (D4). A sandboxed preload cannot require a shared module, so it does
// not re-implement the contract: main validates the handshake, and this gate
// only decides whether to expose anything, enforcing the surface tag.

const HANDSHAKE_PREFIX = "--shiba-bridge=";
const BRIDGE_VERSION = 1;
const DESKTOP_CAPABILITIES = ["status", "unpair", "onStatus", "claudeLogin"];
const SETUP_PAGE = /\/setup\.html$/;

type Surface = "dashboard" | "setup";

type Handshake = {
  origin: string;
  bridgeVersion: number;
  appVersion: string;
  platform: string;
  surface: Surface;
};

/**
 * A non-empty string capped at `max`, mirroring boundedText in the contract:
 * the two layers must refuse the same handshakes (test/preload-gate.e2e.ts).
 */
function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > max) return null;
  return value.includes("\0") ? null : value;
}

/** Origin string with no credentials and a web protocol; anything else is refused. */
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

/** Exactly one handshake argument, parsed and typed; the tag is checked below. */
function readHandshake(): Handshake | null {
  const matches = process.argv.filter((arg) => arg.startsWith(HANDSHAKE_PREFIX));
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
  const appVersion = boundedText(value.appVersion, 64);
  const platform = boundedText(value.platform, 32);
  if (!appVersion || !platform) return null;
  if (value.surface !== "dashboard" && value.surface !== "setup") return null;
  return { origin, bridgeVersion: value.bridgeVersion, appVersion, platform, surface: value.surface };
}

const handshake = readHandshake();
// The bundled setup page is the one explicit exception: a file: document whose
// name is setup.html. It gets only the address bridge, and only that page.
const isBundledSetupPage = location.protocol === "file:" && SETUP_PAGE.test(location.pathname);

if (isBundledSetupPage) {
  contextBridge.exposeInMainWorld("shibaSetup", {
    surface: "setup",
    setUrl: (url: string) => ipcRenderer.invoke("desktop:set-url", url),
  });
} else if (
  handshake &&
  // A `setup`-tagged handshake never exposes the dashboard bridge.
  handshake.surface === "dashboard" &&
  location.origin === handshake.origin
) {
  contextBridge.exposeInMainWorld("shibaDesktop", {
    bridgeVersion: handshake.bridgeVersion,
    appVersion: handshake.appVersion,
    platform: handshake.platform,
    surface: handshake.surface,
    capabilities: DESKTOP_CAPABILITIES,
    status: () => ipcRenderer.invoke("desktop:status"),
    // Compatibility: native pairing is deferred, so main refuses and the page
    // shows the browser direction. No token crosses this bridge.
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
    // Compatibility: an older dashboard still asks for a PKCE callback. Nothing
    // listens; main answers with a fixed refusal so the page shows the browser
    // instruction instead of a broken promise.
    receiveCodexCallback: (_authorizationUrl: string) =>
      ipcRenderer.invoke("desktop:codex-callback"),
  });
}
