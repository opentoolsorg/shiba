/**
 * REVIEW4 F5: the handshake validator lives in main, but the sandboxed preload
 * cannot import it, so the same corpus runs through both. Each entry asserts the
 * real preload's verdict on the page, then asserts main's parseHandshake agrees:
 * a page can only ever see the bridge when the two say the same thing.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, type ElectronApplication } from "playwright-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  BRIDGE_VERSION,
  DESKTOP_CAPABILITIES,
  encodeHandshake,
  parseHandshake,
} from "../src/bridge-contract.js";

const SETUP_FILE = `file://${path.resolve(__dirname, "../dist/setup.html")}`;

let stub: Server;
let origin = "";
const apps: ElectronApplication[] = [];
const userDataDirs: string[] = [];

beforeAll(async () => {
  stub = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><title>${req.url ?? "/"}</title><body>page</body>`);
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => stub.close(resolve));
  for (const app of apps) await app.close().catch(() => undefined);
  for (const dir of userDataDirs) rmSync(dir, { recursive: true, force: true });
});

type Exposed = {
  desktop: string;
  setup: string;
  surface?: string;
  capabilities?: string[];
  version?: number;
};

function handshake(over: Record<string, unknown> = {}): string {
  return encodeHandshake({
    origin,
    bridgeVersion: BRIDGE_VERSION,
    appVersion: "0.1.0",
    platform: "linux",
    surface: "dashboard",
    ...over,
  } as Parameters<typeof encodeHandshake>[0]);
}

async function read(pageUrl: string, args: string[]): Promise<Exposed> {
  const userData = mkdtempSync(path.join(tmpdir(), "shiba-gate-"));
  userDataDirs.push(userData);
  const app = await electron.launch({
    chromiumSandbox: false,
    args: ["test/preload-gate-main.cjs"],
    env: {
      ...(process.env as Record<string, string>),
      SHIBA_GATE_ARGS: JSON.stringify(args),
      SHIBA_GATE_URL: pageUrl,
      SHIBA_GATE_USER_DATA: userData,
    },
  });
  apps.push(app);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return page.evaluate(() => {
    const bridge = (globalThis as unknown as { shibaDesktop?: Record<string, unknown> }).shibaDesktop;
    return {
      desktop: typeof bridge,
      setup: typeof (globalThis as unknown as { shibaSetup?: unknown }).shibaSetup,
      surface: bridge?.surface as string | undefined,
      capabilities: bridge?.capabilities as string[] | undefined,
      version: bridge?.bridgeVersion as number | undefined,
    };
  });
}

const corpus: Array<{ name: string; page: () => string; args: () => string[]; expose: boolean }> = [
  { name: "matching dashboard handshake", page: () => `${origin}/app/`, args: () => [handshake()], expose: true },
  { name: "page on another origin", page: () => `${origin}/app/`, args: () => [handshake({ origin: "https://other.example.com" })], expose: false },
  { name: "setup-tagged handshake on a dashboard page", page: () => `${origin}/app/`, args: () => [handshake({ surface: "setup" })], expose: false },
  { name: "unknown surface", page: () => `${origin}/app/`, args: () => [handshake({ surface: "settings" })], expose: false },
  { name: "future bridge version", page: () => `${origin}/app/`, args: () => [handshake({ bridgeVersion: 2 })], expose: false },
  { name: "origin carrying credentials", page: () => `${origin}/app/`, args: () => [handshake({ origin: origin.replace("http://", "http://user:pw@") })], expose: false },
  { name: "non-web origin", page: () => `${origin}/app/`, args: () => [handshake({ origin: "file:///tmp" })], expose: false },
  { name: "two handshake arguments", page: () => `${origin}/app/`, args: () => [handshake(), handshake()], expose: false },
  { name: "malformed handshake", page: () => `${origin}/app/`, args: () => ["--shiba-bridge={not json"], expose: false },
  { name: "no handshake", page: () => `${origin}/app/`, args: () => [], expose: false },
  { name: "bundled setup page", page: () => SETUP_FILE, args: () => [], expose: true },
  { name: "bundled setup page with a dashboard handshake", page: () => SETUP_FILE, args: () => [handshake()], expose: true },
];

/** What main's validator plus the tag rule would allow on this page. */
function mainWouldExpose(pageUrl: string, args: string[]): boolean {
  // The bundled setup page needs no handshake: it is a file: document inside
  // the app, and its bridge is the address form alone (the documented exception).
  if (pageUrl === SETUP_FILE) return true;
  const parsed = parseHandshake(args);
  if (!parsed) return false;
  return parsed.surface === "dashboard" && parsed.origin === new URL(pageUrl).origin;
}

describe("preload exposure gate", () => {
  test.each(corpus)("$name", async ({ page, args, expose }) => {
    const pageUrl = page();
    const argv = args();
    const exposed = await read(pageUrl, argv);
    // Main's validator must reach the same verdict as the real preload.
    expect(expose).toBe(mainWouldExpose(pageUrl, argv));
    if (pageUrl === SETUP_FILE) {
      // The bundled setup page is the one documented exception: address bridge
      // only, never the dashboard bridge, even with a dashboard handshake present.
      expect(exposed.setup).toBe("object");
      expect(exposed.desktop).toBe("undefined");
      return;
    }
    expect(exposed.desktop).toBe(expose ? "object" : "undefined");
    expect(exposed.setup).toBe("undefined");
    if (expose) {
      expect(exposed.surface).toBe("dashboard");
      expect(exposed.version).toBe(BRIDGE_VERSION);
      // The page sees exactly the contract's capability list, which does not
      // include native pairing.
      expect(exposed.capabilities).toEqual([...DESKTOP_CAPABILITIES]);
      expect(exposed.capabilities).not.toContain("pair");
    }
  });
});
