import { describe, expect, it } from "vitest";
import { PROVIDER_TEST_FRESH_MS, providerLifecycleStatus, providerTestDescription } from "./provider-lifecycle";

describe("provider connection lifecycle", () => {
  const now = 1_000_000;

  it("distinguishes listed, disconnected, pending, connected, tested, stale, and failed states", () => {
    expect(providerLifecycleStatus({ phase: "disconnected", authMode: null, testOk: null, testedAt: null }, now)).toBe("disconnected");
    expect(providerLifecycleStatus({ phase: "waiting", authMode: "oauth", testOk: null, testedAt: null }, now)).toBe("waiting");
    expect(providerLifecycleStatus({ phase: "connected", authMode: "oauth", testOk: null, testedAt: null }, now)).toBe("authenticated");
    expect(providerLifecycleStatus({ phase: "connected", authMode: "api-key", testOk: null, testedAt: null }, now)).toBe("configured");
    expect(providerLifecycleStatus({ phase: "connected", authMode: "oauth", testOk: true, testedAt: now }, now)).toBe("tested");
    expect(providerLifecycleStatus({ phase: "connected", authMode: "oauth", testOk: true, testedAt: now - PROVIDER_TEST_FRESH_MS - 1 }, now)).toBe("stale");
    expect(providerLifecycleStatus({ phase: "connected", authMode: "oauth", testOk: false, testedAt: now }, now)).toBe("testFailed");
    expect(providerLifecycleStatus({ phase: "failed", authMode: null, testOk: null, testedAt: null }, now)).toBe("failed");
  });

  it("does not describe a saved API key as an authenticated provider session", () => {
    expect(providerTestDescription({ phase: "connected", authMode: "api-key", testOk: true, testedAt: now, message: null, operatorSteps: [] }, now))
      .toContain("provider API was not contacted");
  });

  it("calls a prior successful check stale after its bounded health window", () => {
    expect(providerTestDescription({ phase: "connected", authMode: "oauth", testOk: true, testedAt: now - PROVIDER_TEST_FRESH_MS - 1, message: null, operatorSteps: [] }, now))
      .toContain("prior test result is stale");
  });

  it("keeps the provider retry steps visible while disconnected or failed", () => {
    expect(providerTestDescription({ phase: "disconnected", authMode: null, testOk: null, testedAt: null, message: null, operatorSteps: ["Choose Connect with sign-in."] }, now))
      .toContain("Choose Connect with sign-in.");
  });
});
