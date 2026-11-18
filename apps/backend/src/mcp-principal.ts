/**
 * MCP principal header name — shared by the worker entry and MCP routes without
 * pulling the full gateway module at cold start.
 */
export const MCP_PRINCIPAL_HEADER = "x-shiba-principal";