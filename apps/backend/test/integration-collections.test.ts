import { describe, expect, it } from "vitest";
import { INTEGRATION_CATALOG, INTEGRATION_COLLECTIONS, parseIntegrationCollection, setupRequiredCatalog } from "@shiba/shared";

describe("integration browse collections", () => {
  it("parses only listed collections", () => {
    expect(parseIntegrationCollection(null)).toBeUndefined();
    expect(parseIntegrationCollection("")).toBeUndefined();
    expect(parseIntegrationCollection("sales")?.serviceIds).toContain("pipedrive");
    expect(parseIntegrationCollection("everything")).toBeNull();
  });

  it("maps every shelf app to a reference catalog entry", () => {
    const mapped = new Set(INTEGRATION_CATALOG.flatMap((entry) => entry.openConnectorServiceIds ?? []));
    // Linear is a native Shiba integration; its OpenConnector service has no separate catalog row.
    const unmapped = INTEGRATION_COLLECTIONS.flatMap((entry) => entry.serviceIds).filter((id) => id !== "linear" && !mapped.has(id));
    expect(unmapped).toEqual([]);
    for (const entry of INTEGRATION_COLLECTIONS) expect(new Set(entry.serviceIds).size).toBe(entry.serviceIds.length);
  });

  it("narrows the setup-required fallback to a collection", () => {
    const sales = setupRequiredCatalog(undefined, parseIntegrationCollection("sales")?.serviceIds);
    expect(sales.items.map((item) => item.openConnectorProviderId)).toEqual(["hubspot"]);
    expect(sales.total).toBe(1);
    expect(setupRequiredCatalog().items.length).toBeGreaterThan(sales.items.length);
  });
});
