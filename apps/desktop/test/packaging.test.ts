/**
 * Packaging invariants. These read electron-builder.yml rather than a built
 * artifact: a fuse or hardened-runtime regression ships silently otherwise,
 * and a test cannot claim a signed or notarized bundle without credentials.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const desktop = path.resolve(import.meta.dirname, "..");
const config = readFileSync(path.join(desktop, "electron-builder.yml"), "utf8");
const packageJson = JSON.parse(readFileSync(path.join(desktop, "package.json"), "utf8")) as {
  main: string;
};

function fuses(): Record<string, string> {
  const start = config.indexOf("electronFuses:");
  expect(start).toBeGreaterThan(-1);
  const block = config.slice(start + "electronFuses:".length);
  const end = block.search(/^\S/m);
  const body = end === -1 ? block : block.slice(0, end);
  return Object.fromEntries(
    [...body.matchAll(/^ {2}([A-Za-z]+): (\S+)$/gm)].map((m) => [m[1] as string, m[2] as string]),
  );
}

describe("electron fuses", () => {
  it("disables the node, inspect, and file-privilege escape hatches", () => {
    const values = fuses();
    expect(values.runAsNode).toBe("false");
    expect(values.enableNodeOptionsEnvironmentVariable).toBe("false");
    expect(values.enableNodeCliInspectArguments).toBe("false");
    expect(values.grantFileProtocolExtraPrivileges).toBe("false");
  });

  it("pins the app to its asar and keeps integrity + cookie encryption on", () => {
    const values = fuses();
    expect(values.onlyLoadAppFromAsar).toBe("true");
    expect(values.enableEmbeddedAsarIntegrityValidation).toBe("true");
    expect(values.enableCookieEncryption).toBe("true");
  });

  it("carries no fuse set to an insecure value", () => {
    const insecure = new Set([
      "runAsNode",
      "enableNodeOptionsEnvironmentVariable",
      "enableNodeCliInspectArguments",
      "enableCookieEncryption",
      "onlyLoadAppFromAsar",
      "enableEmbeddedAsarIntegrityValidation",
      "grantFileProtocolExtraPrivileges",
    ]);
    for (const [name] of Object.entries(fuses())) expect(insecure).toContain(name);
  });
});

describe("macOS bundle", () => {
  it("keeps the hardened runtime on", () => {
    expect(config).toMatch(/^ {2}hardenedRuntime: true$/m);
  });

  it("declares notarization without embedding credentials", () => {
    expect(config).toMatch(/^ {2}notarize: true$/m);
    expect(config).not.toMatch(/APPLE_(ID|API_KEY)\s*[:=]/);
    expect(config).not.toMatch(/[A-Za-z0-9+/]{40,}={0,2}/);
  });

  it("ships the setup page unpacked where file: can read it", () => {
    const unpacked = config.slice(config.indexOf("asarUnpack:"));
    expect(unpacked).toContain("dist/setup.html");
    expect(unpacked).toContain("dist/setup.js");
    // The native diff window is gone; nothing may keep unpacking its assets.
    expect(unpacked).not.toContain("diff.html");
  });
});

describe("daemon resources", () => {
  it("ships the daemon scripts it forks outside the asar", () => {
    const resources = [...config.matchAll(/^ {2}- from: (.+)$/gm)].map((m) => m[1]?.trim() ?? "");
    expect(resources).toContain("../../scripts/shiba-local-daemon.mjs");
    for (const from of resources) {
      // Sources are tracked; the packaged artifact is built later, so nothing
      // here may depend on dist/ existing when unit tests run.
      expect(existsSync(path.resolve(desktop, from))).toBe(true);
    }
  });

  it("points main at the compiled entry the asar holds", () => {
    // Not asserted on disk: the desktop gate runs unit tests before building.
    expect(packageJson.main).toBe("dist/main.js");
  });

  it("does not publish automatically and keeps the release human-gated", () => {
    expect(config).toMatch(/^ {2}releaseType: draft$/m);
  });
});
