import { describe, expect, it } from "vitest";
import {
  INTEGRATION_CATALOG,
  filterIntegrationCatalogView,
  integrationCatalogEntrySchema,
  integrationCatalogSchema,
  integrationMatchesTab,
  searchIntegrationCatalog,
} from "@shiba/shared";

describe("integration catalog schema", () => {
  it("parses the seeded catalog and enforces unique ids", () => {
    const parsed = integrationCatalogSchema.parse(INTEGRATION_CATALOG);
    const ids = parsed.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(parsed.length).toBe(INTEGRATION_CATALOG.length);
    expect(parsed.length).toBeGreaterThanOrEqual(35);
  });

  it("includes every handover marketing row by id", () => {
    for (const id of [
      "google-ads",
      "meta-ads",
      "x-twitter",
      "linkedin-instagram-youtube",
      "posthog",
      "webflow",
      "wix",
      "klaviyo-brevo",
    ]) {
      expect(INTEGRATION_CATALOG.some((entry) => entry.id === id)).toBe(true);
    }
  });

  it("rejects invalid catalog entries", () => {
    expect(() =>
      integrationCatalogEntrySchema.parse({
        id: "bad",
        name: "Bad",
        domain: "marketing",
        kind: "native",
        docsUrl: "not-a-url",
        status: "live",
        priority: "P0",
        summary: "x",
      }),
    ).toThrow();
  });
});

describe("integration catalog filters", () => {
  const connections = Object.fromEntries(
    INTEGRATION_CATALOG.map((entry) => [entry.id, entry.id === "slack" ? "partial" : "catalog_only"]),
  ) as Record<string, "partial" | "catalog_only">;

  it("filters by search text", () => {
    const hits = searchIntegrationCatalog(INTEGRATION_CATALOG, "hubspot");
    expect(hits.map((entry) => entry.id)).toEqual(["hubspot", "stripe-hubspot-reconcile"]);
  });

  it("applies recommended tab via P0 priority", () => {
    const recommended = filterIntegrationCatalogView(INTEGRATION_CATALOG, {
      search: "",
      domain: "all",
      tab: "recommended",
      connections,
    });
    expect(recommended.every((entry) => entry.priority === "P0")).toBe(true);
    expect(recommended.some((entry) => entry.id === "slack")).toBe(true);
  });

  it("marks needs_attention for partial natives and P0 catalog rows", () => {
    expect(integrationMatchesTab(
      INTEGRATION_CATALOG.find((entry) => entry.id === "slack")!,
      "needs_attention",
      "partial",
    )).toBe(true);
    expect(integrationMatchesTab(
      INTEGRATION_CATALOG.find((entry) => entry.id === "hubspot")!,
      "needs_attention",
      "catalog_only",
    )).toBe(true);
    expect(integrationMatchesTab(
      INTEGRATION_CATALOG.find((entry) => entry.id === "apollo")!,
      "needs_attention",
      "catalog_only",
    )).toBe(false);
  });
});
