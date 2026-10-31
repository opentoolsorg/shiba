/**
 * Permission-filtered projection of the live built-in MCP tool registrations.
 * This module never discovers or contacts remote MCP servers, providers, or
 * app APIs. A catalog entry proves that Shiba registered a handler and that
 * this verified principal has its required tool scope; it does not prove a
 * provider connection or successful health check.
 */
import { z } from "zod";
import type { TokenRecord } from "./agent-tokens.js";
import { orgIdForRecord } from "./agent-tokens.js";
import type { Env } from "./env.js";
import type { ToolMeta, ToolRegistry } from "./mcp-gateway.js";
import { createToolRegistry } from "./mcp-gateway.js";
import { registerAllMcpTools } from "./mcp-tool-registration.js";
import { sha256Hex, type Scope } from "./agent-tokens.js";

export { registerAllMcpTools } from "./mcp-tool-registration.js";

export const BUILTIN_CAPABILITY_SOURCE = "mcp:shiba" as const;
export const BUILTIN_CAPABILITY_VERSION = "1" as const;
export const DEFAULT_CAPABILITY_LIMIT = 40;
export const MAX_CAPABILITY_LIMIT = 50;
export const MAX_CAPABILITY_SCHEMA_BYTES = 12_000;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

export interface CapabilityCatalogOptions {
  /** Return only requested namespaced IDs, after permission filtering. */
  selectedIds?: readonly string[];
  limit?: number;
}

export interface CapabilityCatalogEntry {
  id: string;
  name: string;
  source: typeof BUILTIN_CAPABILITY_SOURCE;
  version: typeof BUILTIN_CAPABILITY_VERSION;
  owner: { orgId: string; principal: string };
  requiredScope: Scope;
  allowed: true;
  status: "available";
  verification: "not_checked";
  healthCheck: { available: false; reason: "no_generic_probe" };
  writeEffect: "read_only" | "may_mutate" | "unknown";
  approval: "not_inferred_from_mcp_metadata";
  schemaVersion: string;
  inputSchema?: Record<string, unknown>;
  schemaOmitted?: "not_registered" | "too_large" | "invalid";
  description: string;
  annotations: Record<string, boolean>;
  supportedActions: string[];
}

export interface CapabilityCatalogResult {
  source: typeof BUILTIN_CAPABILITY_SOURCE;
  version: typeof BUILTIN_CAPABILITY_VERSION;
  owner: { orgId: string; principal: string };
  entries: CapabilityCatalogEntry[];
  totalAuthorized: number;
  returned: number;
  truncated: boolean;
  liveChecksPerformed: false;
}

/** Public dashboard directory: implementation metadata only, no schemas or grants. */
export interface CapabilityDirectoryEntry {
  id: string;
  name: string;
  source: typeof BUILTIN_CAPABILITY_SOURCE;
  version: typeof BUILTIN_CAPABILITY_VERSION;
  requiredScope: Scope;
  allowed: false;
  status: "available";
  verification: "not_checked";
  writeEffect: "read_only" | "may_mutate" | "unknown";
  approval: "not_inferred_from_mcp_metadata";
  description: string;
  annotations: Record<string, boolean>;
}

export interface CapabilityDirectoryResult {
  source: typeof BUILTIN_CAPABILITY_SOURCE;
  version: typeof BUILTIN_CAPABILITY_VERSION;
  entries: CapabilityDirectoryEntry[];
  totalRegistered: number;
  returned: number;
  truncated: boolean;
  liveChecksPerformed: false;
}

/**
 * Public dashboard listing. Dashboard identity does not carry MCP tool
 * scopes, so these entries are informational only: they are explicitly not
 * allowed and never include input schemas or a claim of live connection.
 */
export function buildCapabilityDirectory(
  env: Env,
  options: { limit?: number } = {},
): CapabilityDirectoryResult {
  const limit = boundedLimit(options.limit);
  const registry = createToolRegistry(env);
  registerAllMcpTools(registry, env);
  const tools = registry.tools();
  const seen = new Set<string>();
  const all = tools.map((tool): CapabilityDirectoryEntry => {
    if (!TOOL_NAME.test(tool.name)) throw new Error("Invalid registered capability name.");
    const id = `${BUILTIN_CAPABILITY_SOURCE}:${tool.name}`;
    if (seen.has(id)) throw new Error("Duplicate capability id.");
    seen.add(id);
    const writeEffect = writeEffectFromAnnotations(tool.meta.annotations);
    const annotations: Record<string, boolean> = {};
    for (const key of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
      const value = tool.meta.annotations?.[key];
      if (typeof value === "boolean") annotations[key] = value;
    }
    return {
      id, name: tool.name, source: BUILTIN_CAPABILITY_SOURCE, version: BUILTIN_CAPABILITY_VERSION,
      requiredScope: tool.scope, allowed: false, status: "available", verification: "not_checked",
      writeEffect,
      approval: "not_inferred_from_mcp_metadata",
      description: typeof tool.meta.description === "string" ? tool.meta.description.slice(0, 1200) : tool.name,
      annotations,
    };
  });
  const entries = all.slice(0, limit);
  return {
    source: BUILTIN_CAPABILITY_SOURCE, version: BUILTIN_CAPABILITY_VERSION,
    entries, totalRegistered: all.length, returned: entries.length,
    truncated: entries.length < all.length, liveChecksPerformed: false,
  };
}

/**
 * Return a safe, bounded capability listing for one already-verified MCP
 * principal. API keys are not MCP agent principals. Legacy agent tokens whose
 * kind is absent remain accepted, matching the gateway's existing token
 * compatibility behavior.
 */
export async function buildCapabilityCatalog(
  env: Env,
  principal: TokenRecord,
  options: CapabilityCatalogOptions = {},
): Promise<CapabilityCatalogResult> {
  if (!principal || principal.revoked || principal.kind === "api_key") {
    throw new Error("A verified active MCP agent principal is required.");
  }
  if (principal.expiresAt !== undefined && (!Number.isFinite(principal.expiresAt) || Date.now() >= principal.expiresAt)) {
    throw new Error("A verified active MCP agent principal is required.");
  }
  if (!Array.isArray(principal.scopes) || !principal.scopes.every((scope) => typeof scope === "string")) {
    throw new Error("A verified active MCP agent principal is required.");
  }
  const limit = boundedLimit(options.limit);
  const registry = createToolRegistry(env);
  registerAllMcpTools(registry, env);
  const selected = options.selectedIds ? new Set(options.selectedIds.slice(0, 200)) : null;
  const authorized = filterRegisteredTools(registry.tools(), principal, selected);
  const page = authorized.slice(0, limit);
  // Generate bounded JSON Schemas only for the selected, authorized page.
  const entries = await projectRegisteredTools(page, principal);
  const owner = { orgId: orgIdForRecord(principal), principal: principal.principal };
  return {
    source: BUILTIN_CAPABILITY_SOURCE,
    version: BUILTIN_CAPABILITY_VERSION,
    owner,
    entries,
    totalAuthorized: authorized.length,
    returned: entries.length,
    truncated: entries.length < authorized.length,
    liveChecksPerformed: false,
  };
}

/** Exported for deterministic namespace-collision and bounds regression tests. */
export async function projectRegisteredTools(
  tools: readonly RegisteredCapabilityTool[],
  principal: TokenRecord,
  selectedIds: ReadonlySet<string> | null = null,
): Promise<CapabilityCatalogEntry[]> {
  const owner = { orgId: orgIdForRecord(principal), principal: principal.principal };
  const result: CapabilityCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const tool of tools) {
    if (!TOOL_NAME.test(tool.name)) throw new Error("Invalid registered capability name.");
    const id = `${BUILTIN_CAPABILITY_SOURCE}:${tool.name}`;
    if (seen.has(id)) throw new Error("Duplicate capability id.");
    seen.add(id);
    if (!principal.scopes.includes(tool.scope)) continue;
    if (selectedIds && !selectedIds.has(id)) continue;
    const { schema, omission } = makeBoundedSchema(tool.meta.inputSchema);
    const writeEffect = writeEffectFromAnnotations(tool.meta.annotations);
    const annotations: Record<string, boolean> = {};
    for (const key of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
      const value = tool.meta.annotations?.[key];
      if (typeof value === "boolean") annotations[key] = value;
    }
    const description = typeof tool.meta.description === "string" ? tool.meta.description.slice(0, 1200) : tool.name;
    const schemaVersion = schema ? await sha256Hex(JSON.stringify(schema)) : "unavailable";
    result.push({
      id,
      name: tool.name,
      source: BUILTIN_CAPABILITY_SOURCE,
      version: BUILTIN_CAPABILITY_VERSION,
      owner,
      requiredScope: tool.scope,
      allowed: true,
      status: "available",
      verification: "not_checked",
      healthCheck: { available: false, reason: "no_generic_probe" },
      writeEffect,
      approval: "not_inferred_from_mcp_metadata",
      schemaVersion,
      ...(schema ? { inputSchema: schema } : omission ? { schemaOmitted: omission } : {}),
      description,
      annotations,
      supportedActions: [tool.name],
    });
  }
  return result;
}

function filterRegisteredTools(
  tools: readonly RegisteredCapabilityTool[],
  principal: TokenRecord,
  selectedIds: ReadonlySet<string> | null,
): RegisteredCapabilityTool[] {
  const result: RegisteredCapabilityTool[] = [];
  const seen = new Set<string>();
  for (const tool of tools) {
    if (!TOOL_NAME.test(tool.name)) throw new Error("Invalid registered capability name.");
    const id = `${BUILTIN_CAPABILITY_SOURCE}:${tool.name}`;
    if (seen.has(id)) throw new Error("Duplicate capability id.");
    seen.add(id);
    if (!principal.scopes.includes(tool.scope)) continue;
    if (selectedIds && !selectedIds.has(id)) continue;
    result.push(tool);
  }
  return result;
}

function writeEffectFromAnnotations(
  annotations: ToolMeta["annotations"] | undefined,
): CapabilityDirectoryEntry["writeEffect"] {
  if (annotations?.readOnlyHint === true) return "read_only";
  if (annotations?.readOnlyHint === false) return "may_mutate";
  return "unknown";
}

export interface RegisteredCapabilityTool {
  name: string;
  scope: Scope;
  meta: ToolMeta;
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CAPABILITY_LIMIT;
  if (!Number.isInteger(value) || value < 1) throw new Error("Capability limit must be a positive integer.");
  return Math.min(value, MAX_CAPABILITY_LIMIT);
}

function makeBoundedSchema(shape: ToolMeta["inputSchema"]): {
  schema?: Record<string, unknown>;
  omission?: NonNullable<CapabilityCatalogEntry["schemaOmitted"]>;
} {
  if (!shape) return { omission: "not_registered" };
  try {
    const schema = z.toJSONSchema(z.object(shape as never), { target: "draft-7" }) as Record<string, unknown>;
    const properties = schema.properties;
    if (properties && typeof properties === "object" && Object.keys(properties).length > 64) return { omission: "too_large" };
    if (JSON.stringify(schema).length > MAX_CAPABILITY_SCHEMA_BYTES) return { omission: "too_large" };
    return { schema };
  } catch {
    return { omission: "invalid" };
  }
}
