/* eslint-disable no-restricted-imports -- These adapters import backend-internal modules, three directories below src/. */
import type { ConnectorProvider } from "../../../ports/connector/provider.js";
import { ConnectorProviderError } from "../../../ports/connector/errors.js";

/** Disabled implementation: never opens a gateway connection. */
export class NoneConnectorProvider implements ConnectorProvider {
  readonly id = "openconnector" as const;
  readonly adapterId = "none" as const;
  readonly capabilities = { configured: false, authTypes: [], actions: false } as const;
  async health() {
    return { provider: this.id, status: "unconfigured" as const, checkedAt: Date.now(), message: "Set up a connector provider." };
  }
  private missing(): never {
    throw new ConnectorProviderError("Set up a connector provider.", "not_configured");
  }
  async listCatalog(): Promise<never> { return this.missing(); }
  async listConnections(): Promise<never> { return this.missing(); }
  async searchActions(): Promise<never> { return this.missing(); }
  async disconnect(): Promise<never> { return this.missing(); }
  async beginConnect() { return { ok: false, provider: this.id, error: "not_configured" }; }
  async executeTool() { return { ok: false, status: "failed" as const, error: "not_configured" }; }
}
