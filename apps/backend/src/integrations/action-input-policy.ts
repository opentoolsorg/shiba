import type { IntegrationAction } from "./contracts.js";

/** Pinned upstream Google Ads schemas expose a protected developer credential as action input. */
export const CREDENTIAL_INPUT_UNAVAILABLE = "Google Ads actions that expose developer credentials as inputs are unavailable. Configure credentials only in protected provider setup; never paste them into action inputs.";

export class IntegrationActionInputPolicyError extends Error {
  constructor() { super(CREDENTIAL_INPUT_UNAVAILABLE); this.name = "IntegrationActionInputPolicyError"; }
}

/** Explicit compatibility policy, not a generic schema or secret-name heuristic. */
export function requiresProtectedActionInput(action: Pick<IntegrationAction, "service" | "inputSchema">): boolean {
  if (action.service !== "googleads") return false;
  const schema = action.inputSchema;
  if (!schema) return false;
  const properties = schema.properties;
  return (Array.isArray(schema.required) && schema.required.includes("developerToken")) ||
    (typeof properties === "object" && properties !== null && Object.hasOwn(properties, "developerToken"));
}

export function assertActionArgumentsAllowed(service: string, args: Record<string, unknown>, actionId?: string): void {
  if ((service === "googleads" || actionId?.startsWith("googleads.")) && Object.hasOwn(args, "developerToken")) throw new IntegrationActionInputPolicyError();
}

export function assertActionInputAllowed(action: Pick<IntegrationAction, "service" | "inputSchema">, args?: Record<string, unknown>): void {
  if (requiresProtectedActionInput(action)) throw new IntegrationActionInputPolicyError();
  if (args) assertActionArgumentsAllowed(action.service, args);
}
