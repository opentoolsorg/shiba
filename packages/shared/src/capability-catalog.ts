/** Public read-only projection of Shiba's built-in MCP handler registry. */
export interface McpCapabilityDirectoryEntry {
  id: string;
  name: string;
  source: "mcp:shiba";
  version: string;
  requiredScope: string;
  /** false means directory discovery did not grant this dashboard identity tool access. */
  allowed: false;
  status: "available";
  verification: "not_checked";
  writeEffect: "read_only" | "may_mutate" | "unknown";
  approval: "not_inferred_from_mcp_metadata";
  description: string;
  annotations: Record<string, boolean>;
}

export interface McpCapabilityDirectory {
  source: "mcp:shiba";
  version: string;
  entries: McpCapabilityDirectoryEntry[];
  totalRegistered: number;
  returned: number;
  truncated: boolean;
  liveChecksPerformed: false;
}
