/**
 * The desktop bridge contract: channel allowlist, payload caps, and the
 * handshake the preload publishes. Electron-free, so main, the tests, and the
 * dashboard types share one source. The sandboxed preload cannot require it —
 * it carries the same literals, and test/bridge-contract.test.ts fails when
 * the two drift.
 */

export const BRIDGE_VERSION = 1;

/** Channels the dashboard surface can invoke, plus the one main pushes on. */
export const DESKTOP_CHANNELS = {
  status: "desktop:status",
  pair: "desktop:pair",
  unpair: "desktop:unpair",
  statusChanged: "desktop:status-changed",
  claudeLogin: "desktop:claude-login",
} as const;

export const SETUP_CHANNELS = {
  setUrl: "desktop:set-url",
} as const;

export const ALLOWED_CHANNELS: readonly string[] = [
  ...Object.values(DESKTOP_CHANNELS),
  ...Object.values(SETUP_CHANNELS),
];

export const DESKTOP_CAPABILITIES = [
  "status",
  "pair",
  "unpair",
  "onStatus",
  "claudeLogin",
] as const;

export type DesktopCapability = (typeof DESKTOP_CAPABILITIES)[number];

export const SETUP_CAPABILITIES = ["setUrl"] as const;

/** Pairing tokens are two base64url segments; the server schema caps them at 1024. */
export const MAX_PAIRING_TOKEN_CHARS = 1024;
/** A deployment URL is an origin; anything longer is not one. */
export const MAX_DEPLOYMENT_URL_CHARS = 2048;
/** App paths the shell loads are `/app/` or `/app/?tab=<known>`; see isSafeAppPath. */
export const MAX_APP_PATH_CHARS = 256;

export interface BridgeHandshake {
  origin: string;
  bridgeVersion: number;
  appVersion: string;
  platform: string;
}

export const HANDSHAKE_ARG = "--shiba-bridge=";

/** The single BrowserWindow argument that carries the handshake into the preload. */
export function encodeHandshake(handshake: BridgeHandshake): string {
  return `${HANDSHAKE_ARG}${JSON.stringify(handshake)}`;
}

/** Strict read of a preload argv; anything malformed returns null so the bridge stays hidden. */
export function parseHandshake(argv: readonly string[]): BridgeHandshake | null {
  const matches = argv.filter((arg) => arg.startsWith(HANDSHAKE_ARG));
  if (matches.length !== 1) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse((matches[0] as string).slice(HANDSHAKE_ARG.length));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const value = parsed as Partial<BridgeHandshake>;
  const origin = absoluteOrigin(value.origin);
  if (!origin) return null;
  if (value.bridgeVersion !== BRIDGE_VERSION) return null;
  const appVersion = boundedText(value.appVersion, 64);
  const platform = boundedText(value.platform, 32);
  if (!appVersion || !platform) return null;
  return { origin, bridgeVersion: BRIDGE_VERSION, appVersion, platform };
}

/** A non-empty string capped at `max`; null otherwise. */
export function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > max) return null;
  if (value.includes("\0")) return null;
  return value;
}

function absoluteOrigin(value: unknown): string | null {
  const text = boundedText(value, MAX_DEPLOYMENT_URL_CHARS);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.username || url.password) return null;
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}
