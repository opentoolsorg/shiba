import { describe, expect, it } from "vitest";
import { INTEGRATION_CATALOG, integrationCatalogEntrySchema } from "@shiba/shared";

// IDs verified against the separate upstream v1.9.4 provider definitions.
describe("OpenConnector catalog mappings", () => {
  it("maps differing service IDs without claiming the planned path is live", () => {
    for (const [id, service] of [
      ["google-ads", "googleads"], ["meta-ads", "meta"], ["x-twitter", "twitter"],
      ["microsoft-teams", "microsoft_teams"], ["jira-atlassian", "jira"],
    ]) {
      expect(INTEGRATION_CATALOG.find((entry) => entry.id === id)).toMatchObject({
        openConnectorServiceIds: [service], status: "catalog_only",
      });
    }
  });

  it("preserves separate service IDs for grouped rows and leaves ambiguous rows unmapped", () => {
    expect(INTEGRATION_CATALOG.find((entry) => entry.id === "google-drive-docs-sheets")?.openConnectorServiceIds)
      .toEqual(["googledrive", "googledocs", "googlesheets"]);
    for (const id of ["wix", "onedrive", "gong-zoominfo", "fal-krea", "stripe-hubspot-reconcile"]) {
      expect(INTEGRATION_CATALOG.find((entry) => entry.id === id)?.openConnectorServiceIds).toBeUndefined();
    }
  });

  it("requires nonempty service IDs", () => {
    expect(integrationCatalogEntrySchema.safeParse({ ...INTEGRATION_CATALOG[0], openConnectorServiceIds: [""] }).success).toBe(false);
  });
});
