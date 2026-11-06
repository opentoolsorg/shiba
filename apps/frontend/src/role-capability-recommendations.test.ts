import { describe, expect, it } from "vitest";
import { CUSTOM_AGENT_ROLE_TEMPLATE_IDS, CURATED_MCP_VENDORS, INTEGRATION_CATALOG } from "@shiba/shared";
import { integrationRecommendedForRole, roleCapabilityRecommendations } from "./role-capability-recommendations";

describe("role capability discovery", () => {
  it("only recommends cataloged apps and supported presets for every optional role", () => {
    for (const role of CUSTOM_AGENT_ROLE_TEMPLATE_IDS) {
      const recommendation = roleCapabilityRecommendations(role);
      expect(recommendation.integrationIds.every((id) => INTEGRATION_CATALOG.some((entry) => entry.id === id))).toBe(true);
      expect(recommendation.mcpCatalogIds.every((id) => CURATED_MCP_VENDORS.some((entry) => entry.catalogId === id))).toBe(true);
      expect(recommendation.setup.policyHref).toBe("/employee-tools/");
    }
  });

  it("matches exact mapped provider service IDs without recommending arbitrary providers", () => {
    const item = { id: "googleads", providerKey: "googleads", name: "Ads", description: "", source: "openconnector" as const, connectable: true, isConnected: false };
    expect(integrationRecommendedForRole("marketing", undefined, item)).toBe(true);
    expect(integrationRecommendedForRole("finance", undefined, item)).toBe(false);
    expect(integrationRecommendedForRole("marketing", undefined, { ...item, providerKey: "unverified-ads", id: "unverified-ads" })).toBe(false);
    expect(integrationRecommendedForRole("all", undefined, item)).toBe(true);
  });
});
