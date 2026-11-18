import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_CHANNELS,
  boundedText,
  DESKTOP_CAPABILITIES,
  DESKTOP_CHANNELS,
  encodeHandshake,
  HANDSHAKE_ARG,
  parseHandshake,
  SETUP_CHANNELS,
} from "../src/bridge-contract.js";

const ORIGIN = "https://app.tryshiba.dev";
const handshake = {
  origin: ORIGIN,
  bridgeVersion: 1,
  appVersion: "0.1.0",
  platform: "darwin",
};

describe("handshake", () => {
  it("round-trips the five fields the dashboard needs", () => {
    expect(parseHandshake(["electron", encodeHandshake(handshake)])).toEqual(handshake);
  });

  it("rejects anything malformed rather than exposing a partial bridge", () => {
    const cases: string[][] = [
      [],
      [`${HANDSHAKE_ARG}not json`],
      [`${HANDSHAKE_ARG}{"origin":"${ORIGIN}"}`],
      [encodeHandshake({ ...handshake, bridgeVersion: 2 })],
      [encodeHandshake({ ...handshake, origin: "" })],
      [encodeHandshake({ ...handshake, origin: "file:///etc/passwd" })],
      [encodeHandshake({ ...handshake, origin: "https://user:pw@app.tryshiba.dev" })],
      [encodeHandshake({ ...handshake, appVersion: "x".repeat(65) })],
      [encodeHandshake({ ...handshake, platform: "x".repeat(33) })],
      [encodeHandshake(handshake), encodeHandshake(handshake)],
    ];
    for (const argv of cases) expect(parseHandshake(argv)).toBeNull();
  });

  it("reduces a full URL to its origin", () => {
    const parsed = parseHandshake([
      encodeHandshake({ ...handshake, origin: `${ORIGIN}/app/?tab=diff#x` }),
    ]);
    expect(parsed?.origin).toBe(ORIGIN);
  });
});

describe("boundedText", () => {
  it("accepts bounded strings and rejects the rest", () => {
    expect(boundedText("abc", 3)).toBe("abc");
    expect(boundedText("abcd", 3)).toBeNull();
    expect(boundedText("", 3)).toBeNull();
    expect(boundedText("a\0b", 3)).toBeNull();
    expect(boundedText(7, 3)).toBeNull();
    expect(boundedText(undefined, 3)).toBeNull();
  });
});

describe("preload contract", () => {
  const preload = readFileSync(
    path.resolve(import.meta.dirname, "../src/preload.ts"),
    "utf8",
  );

  it("uses no channel outside the allowlist", () => {
    const literals = [...preload.matchAll(/"((?:desktop|shiba):[a-z-]+)"/g)].map((m) => m[1]);
    expect(literals.length).toBeGreaterThan(0);
    for (const channel of literals) expect(ALLOWED_CHANNELS).toContain(channel);
  });

  it("invokes every desktop channel the contract declares, and nothing more", () => {
    const invokes = [...preload.matchAll(/ipcRenderer\.invoke\("([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(invokes)).toEqual(
      new Set([
        DESKTOP_CHANNELS.status,
        DESKTOP_CHANNELS.pair,
        DESKTOP_CHANNELS.unpair,
        DESKTOP_CHANNELS.claudeLogin,
        SETUP_CHANNELS.setUrl,
      ]),
    );
  });

  it("advertises exactly the capabilities it implements", () => {
    const advertised = /const DESKTOP_CAPABILITIES = (\[[^\]]*\])/.exec(preload)?.[1];
    expect(advertised).toBeDefined();
    expect(JSON.parse(advertised as string)).toEqual([...DESKTOP_CAPABILITIES]);
    const exposed = [...preload.matchAll(/^ {4}([a-zA-Z]+):/gm)].map((m) => m[1]);
    expect(exposed).toEqual(
      expect.arrayContaining([
        "bridgeVersion",
        "appVersion",
        "platform",
        "capabilities",
        "status",
        "pair",
        "unpair",
        "onStatus",
        "startClaudeLogin",
      ]),
    );
    expect(preload).toContain(`HANDSHAKE_PREFIX = "${HANDSHAKE_ARG}"`);
    expect(preload).toContain("bridgeVersion !== BRIDGE_VERSION");
  });
});
