import { describe, expect, it } from "vitest";
import { gatewayCredentialState, providerPhaseLabel } from "./ProvidersView";
import { visibleFlowError } from "./SubscriptionConnect";

describe("visibleFlowError", () => {
  it("hides a flow error that repeats the failed snapshot message", () => {
    expect(visibleFlowError("failed", "  invalid credential  ", "invalid credential")).toBeNull();
  });

  it("keeps a flow error that differs from the failed snapshot message", () => {
    expect(visibleFlowError("failed", "credential rejected", "request timed out")).toBe(
      "request timed out",
    );
  });

  it("keeps a flow error outside the failed phase", () => {
    expect(visibleFlowError("waiting", "credential rejected", "request timed out")).toBe(
      "request timed out",
    );
  });
});

describe("gatewayCredentialState", () => {
  it("reports an unknown gateway neutrally", () => {
    expect(gatewayCredentialState(undefined)).toEqual({
      tone: "neutral",
      label: "AI Gateway",
      hint: null,
    });
    expect(
      gatewayCredentialState({
        id: "gateway",
        token: false,
        reachable: "unknown",
      }),
    ).toEqual({
      tone: "neutral",
      label: "AI Gateway",
      hint: null,
    });
  });

  it("reports a reachable gateway as ready", () => {
    expect(
      gatewayCredentialState({
        id: "gateway",
        token: true,
        reachable: "yes",
      }),
    ).toEqual({ tone: "ok", label: "Ready", hint: null });
  });

  it("explains unauthorized gateways with and without a token", () => {
    expect(
      gatewayCredentialState({
        id: "gateway",
        token: false,
        reachable: "unauthorized",
      }),
    ).toEqual({
      tone: "warning",
      label: "Gateway unauthorized",
      hint: "Set AI_GATEWAY_TOKEN: npx wrangler secret put AI_GATEWAY_TOKEN",
    });
    expect(
      gatewayCredentialState({
        id: "gateway",
        token: true,
        reachable: "unauthorized",
      }),
    ).toEqual({
      tone: "warning",
      label: "Gateway unauthorized",
      hint: "AI_GATEWAY_TOKEN was rejected by the gateway — rotate it.",
    });
  });

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

  it("explains a failed gateway probe", () => {
    expect(
      gatewayCredentialState({
        id: "gateway",
        token: true,
        reachable: "error",
      }),
    ).toEqual({
      tone: "warning",
      label: "Gateway error",
      hint: "The AI Gateway probe failed — check GATEWAY_ID.",
    });
  });
});
