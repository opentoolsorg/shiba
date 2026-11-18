import type { DesktopCapability, ShibaDesktopBridge } from "@shiba/shared";
import { describe, expect, it } from "vitest";
import { desktopCanSignInClaude, desktopHasCapability } from "./desktop-provider";

const bridge = (capabilities: DesktopCapability[]): ShibaDesktopBridge =>
  ({
    bridgeVersion: 1,
    appVersion: "0.1.0",
    platform: "darwin",
    capabilities,
  }) as unknown as ShibaDesktopBridge;

describe("desktopHasCapability", () => {
  it("reads the shell's advertised capability list", () => {
    expect(desktopHasCapability(bridge(["status", "claudeLogin"]), "claudeLogin")).toBe(true);
    expect(desktopHasCapability(bridge(["status", "pair"]), "claudeLogin")).toBe(false);
  });

  it("stays false without a bridge or without a list", () => {
    expect(desktopHasCapability(undefined, "claudeLogin")).toBe(false);
    expect(desktopHasCapability({} as ShibaDesktopBridge, "status")).toBe(false);
  });
});

describe("desktopCanSignInClaude", () => {
  it("is true only for Claude when the shell advertises claudeLogin", () => {
    expect(desktopCanSignInClaude(bridge(["status", "claudeLogin"]), "claude")).toBe(true);
    expect(desktopCanSignInClaude(bridge(["status", "claudeLogin"]), "codex")).toBe(false);
    expect(desktopCanSignInClaude(bridge(["status"]), "claude")).toBe(false);
    expect(desktopCanSignInClaude(undefined, "claude")).toBe(false);
  });

  it("never advertises the retired native ChatGPT receiver", () => {
    // The shell has no loopback listener, so no capability may revive that button.
    expect(desktopHasCapability(bridge(["status", "pair", "unpair", "onStatus", "claudeLogin"]), "status")).toBe(true);
  });
});
