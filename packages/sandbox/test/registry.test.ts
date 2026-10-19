import { describe, expect, it } from "vitest";
import {
  clearSandboxProviderRegistry,
  listRegisteredSandboxProviders,
  parseSandboxProviderId,
  registerBuiltinSandboxProviders,
  registerSandboxProvider,
} from "../src/index.js";

describe("sandbox provider registry", () => {
  it("includes built-ins after package load", () => {
    expect(listRegisteredSandboxProviders()).toContain("cloudflare");
    expect(listRegisteredSandboxProviders()).toContain("computesdk");
  });

  it("accepts custom registrations", () => {
    clearSandboxProviderRegistry();
    registerBuiltinSandboxProviders();
    registerSandboxProvider("acme", () => ({
      id: "acme",
      capabilities: {
        edgeEgressEnforcement: false,
        previewUrls: false,
        snapshots: false,
        streamingExec: false,
        backgroundProcesses: false,
        rawProviderHandle: false,
      },
      get: async () => {
        throw new Error("not implemented");
      },
      destroy: async () => {},
    }));
    expect(parseSandboxProviderId("acme")).toBe("acme");
  });
});
