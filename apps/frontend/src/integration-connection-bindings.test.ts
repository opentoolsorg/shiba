import { describe, expect, it } from "vitest";
import { INTEGRATION_CATALOG } from "@shiba/shared";
import { buildIntegrationConnectionSnapshot, type IntegrationBindingInputs } from "./integration-connection-bindings";

const inputs: IntegrationBindingInputs = { setupLoading: false, mailboxCount: 0, mailboxLoading: false, gmailConnected: false, gmailLoading: false, externalMcpServerCount: 0, externalMcpCatalogConnections: [], externalMcpLoading: false };

describe("integration readiness facts", () => {
  it.each(["draft", "discovered", "reviewed", "error"])("does not count %s MCP configuration as a usable connection", (status) => {
    const result = buildIntegrationConnectionSnapshot(INTEGRATION_CATALOG, { ...inputs, externalMcpServerCount: 1, externalMcpCatalogConnections: [{ catalogId: "stripe", connectionLabel: "private", status, health: "healthy" }] });
    expect(result.stripe).toBe("partial");
    expect(result["external-mcp"]).toBe("partial");
  });

  it("requires both enabled tools and healthy transport, and preserves deployment-only availability", () => {
    const snapshot = (status: string, health?: string) => buildIntegrationConnectionSnapshot(INTEGRATION_CATALOG, { ...inputs, externalMcpCatalogConnections: [{ catalogId: "stripe", connectionLabel: null, status, health }] });
    expect(snapshot("enabled", "healthy").stripe).toBe("configured");
    expect(snapshot("enabled", "error").stripe).toBe("partial");
    expect(snapshot("enabled").stripe).toBe("partial");
    expect(snapshot("disabled", "healthy").stripe).toBe("not_set_up");
    expect(snapshot("enabled", "healthy").telegram).toBe("available_via_deployment");
  });
});
