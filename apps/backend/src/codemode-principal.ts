import { SCOPES, type Scope, type TokenRecord } from "./agent-tokens.js";

/** The shared cross-user principal must never inherit personal Gmail access. */
export const ORCHESTRATOR_SCOPES: Scope[] = SCOPES.filter((s) => s !== "admin:tokens" && s !== "gmail:read");

export const ORCHESTRATOR_PRINCIPAL: TokenRecord = {
  principal: "orchestrator-agent",
  scopes: ORCHESTRATOR_SCOPES,
  created: 0,
  revoked: false,
};