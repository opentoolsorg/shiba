import { describe, expect, it } from "vitest";
import { providerPhaseLabel } from "./provider-phase";

describe("providerPhaseLabel", () => {
  it("names each provider connection phase", () => {
    expect(providerPhaseLabel({ phase: "disconnected", testOk: null })).toEqual({
      tone: "neutral",
      label: "Not connected",
    });
    expect(providerPhaseLabel({ phase: "waiting", testOk: null })).toEqual({
      tone: "pending",
      label: "Sign-in pending",
    });
    expect(providerPhaseLabel({ phase: "connected", testOk: null })).toEqual({
      tone: "ok",
      label: "Connected",
    });
    expect(providerPhaseLabel({ phase: "connected", testOk: true })).toEqual({
      tone: "ok",
      label: "Ready",
    });
    expect(providerPhaseLabel({ phase: "connected", testOk: false })).toEqual({
      tone: "danger",
      label: "Test failed",
    });
    expect(providerPhaseLabel({ phase: "failed", testOk: null })).toEqual({
      tone: "danger",
      label: "Connection failed",
    });
  });
});
