import { describe, expect, it } from "vitest";
import { assertProviderAllowed, parseSandboxProviderId, registerBuiltinSandboxProviders } from "../src/index.js";
import { createE2bSandboxProvider } from "../src/adapters/e2b.js";

registerBuiltinSandboxProviders();

describe("parseSandboxProviderId", () => {
  it("defaults to cloudflare", () => {
    expect(parseSandboxProviderId(undefined)).toBe("cloudflare");
  });
  it("rejects unknown", () => {
    expect(() => parseSandboxProviderId("fly")).toThrow(/Unknown/);
  });
});

describe("assertProviderAllowed", () => {
  it("blocks unenforced egress by default", () => {
    const provider = createE2bSandboxProvider({ mockInstance: true });
    expect(() => assertProviderAllowed(provider, {})).toThrow(/SHIBA_SANDBOX_ALLOW_UNENFORCED_EGRESS/);
  });
  it("allows opt-in", () => {
    const provider = createE2bSandboxProvider({ mockInstance: true });
    expect(() => assertProviderAllowed(provider, { allowUnenforcedEgress: true })).not.toThrow();
  });
});
