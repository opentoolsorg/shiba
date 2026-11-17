import { describe, expect, it } from "vitest";
import { FEATURED_INTEGRATIONS, featuredSetupItems, mergeFeaturedWithLive } from "@shiba/shared";

describe("featured integration catalog", () => {
  it("lists the P0 apps with complete fields", () => {
    const ids = FEATURED_INTEGRATIONS.map((entry) => entry.id);
    expect(ids).toEqual(expect.arrayContaining(["stripe", "hubspot", "google-ads", "meta-ads", "notion", "gmail", "google-calendar", "slack", "github"]));
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of FEATURED_INTEGRATIONS) {
      expect(entry.name).toBeTruthy();
      expect(entry.category).toBeTruthy();
      expect(entry.description).not.toContain("\n");
      expect(["oauth", "api-key"]).toContain(entry.authKind);
      expect(entry.openConnectorProviderId).toBeTruthy();
      expect(entry.scopesSummary).toBeTruthy();
      if (entry.logo) expect(entry.logo).toMatch(/^\/integration-logos\/.+\.svg$/);
    }
  });

  it("marks every setup item unavailable and merges live rows by provider id", () => {
    expect(featuredSetupItems().every((item) => !item.available && item.reason === "setup_required")).toBe(true);
    const merged = mergeFeaturedWithLive([{ id: "x", providerKey: "googleads", name: "Google Ads", description: "d", source: "openconnector", isConnected: false, connectable: true }]);
    expect(merged.find((item) => item.id === "google-ads")?.available).toBe(true);
    expect(merged.find((item) => item.id === "notion")?.available).toBe(false);
  });
});
