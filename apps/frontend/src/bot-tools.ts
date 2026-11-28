/**
 * The Tools list in a bot's Details tab. Every row states what Shiba actually
 * enforces for this bot today. Nothing here can grant anything: a row is a
 * report plus, where a control exists, a link to the surface that owns it.
 */

/** One capability grant the existing employee tool policy holds for this bot version. */
export interface BotToolGrant {
  capabilityId: string;
  resourceId: string;
  lifecycle: string;
}

export interface BotToolPolicy {
  employeeVersion: number;
  toolScopes: readonly string[];
  grants: readonly BotToolGrant[];
}


export type BotToolState =
  /** Granted and switched on for this bot version: the run can use it. */
  | "on"
  /** Granted by policy but left out of this bot's tool scopes: the run cannot use it. */
  | "off"
  /** The bot names it, but no active grant backs it, so the server refuses it. */
  | "ungranted"
  /** A workspace-wide surface with no per-bot switch in Shiba today. */
  | "workspace"
  /** Present in Shiba only behind a deployment setting or a surface that has not landed. */
  | "unavailable"
  /** The policy could not be read, so this row is unknown rather than empty. */
  | "unknown";

export interface BotToolRow {
  id: string;
  label: string;
  detail: string;
  state: BotToolState;
  /** Where the viewer can manage or open this capability, when that surface exists. */
  href?: string;
}

const isExternalMcpScope = (id: string) => id.startsWith("mcp:shiba:ext_");

/** A capability is usable only when the bot version names it AND a grant backs it. */
export function botCapabilityState(id: string, policy: BotToolPolicy): "on" | "off" | "ungranted" {
  const granted = policy.grants.some((grant) => grant.capabilityId === id && grant.lifecycle === "active");
  const enabled = policy.toolScopes.includes(id);
  if (!granted) return "ungranted";
  return enabled ? "on" : "off";
}

function countActive(policy: BotToolPolicy, predicate: (id: string) => boolean): number {
  return [...new Set(policy.grants.filter((grant) => grant.lifecycle === "active" && predicate(grant.capabilityId)).map((grant) => grant.capabilityId))].length;
}

/**
 * The primary capability groups in display order, then Shiba's own run
 * and email capabilities. `policy` is null while it is loading or after it
 * failed — rows then report `unknown` instead of implying the bot has none.
 */
export function botToolRows(options: {
  policy: BotToolPolicy | null;
  policyError: string | null;
  webSearchReady: boolean | null;
}): BotToolRow[] {
  const { policy, policyError, webSearchReady } = options;
  const unknown = policy === null;
  const rows: BotToolRow[] = [];

  const appCapabilities = ["mcp:shiba:integrations.search_actions", "mcp:shiba:integrations.execute"] as const;
  const appStates = policy ? appCapabilities.map((id) => botCapabilityState(id, policy)) : [];
  const appGranted = appStates.filter((state) => state === "on" || state === "off").length;
  rows.push({
    id: "integrations",
    label: "Connected apps",
    detail: unknown
      ? (policyError ?? "Checking this bot's app grants…")
      : appGranted > 0
        ? `${appGranted} of ${appCapabilities.length} grants switched on for this bot`
        : "No app grant on this bot yet",
    state: unknown ? "unknown" : appGranted > 0 ? "workspace" : "ungranted",
    href: "/settings/?section=employee-tools",
  });

  const externalActive = policy ? countActive(policy, isExternalMcpScope) : 0;
  rows.push({
    id: "mcp",
    label: "MCP servers",
    detail: unknown
      ? (policyError ?? "Checking this bot's MCP grants…")
      : externalActive > 0
        ? `${externalActive} granted MCP tool${externalActive === 1 ? "" : "s"} for this bot`
        : "No MCP tool is granted to this bot",
    state: unknown ? "unknown" : externalActive > 0 ? "workspace" : "ungranted",
    href: "/settings/?section=employee-tools",
  });

  rows.push({
    id: "web_search",
    label: "Web search",
    detail: webSearchReady === true
      ? "Provided by the workspace chat tools when a search key is configured. Not scoped per bot."
      : webSearchReady === false
        ? "No search provider is configured on this deployment (WEB_SEARCH_API_KEY)."
        : "Reading the deployment's search setting…",
    state: webSearchReady === false ? "unavailable" : "workspace",
  });

  for (const [id, label, href] of [
    ["memory", "Memory", "/memory"],
    ["knowledge", "Knowledge", "/files"],
    ["files", "Files", "/files"],
    ["notes", "Notes", "/notes"],
    ["skills", "Skills", "/skills"],
  ] as const) {
    rows.push({
      id,
      label,
      detail: "Workspace-wide. Shiba has no per-bot switch for this, so every bot on this workspace sees the same set.",
      state: "workspace",
      href,
    });
  }

  const runIds = ["mcp:shiba:run_status", "mcp:shiba:queue_run"] as const;
  const emailIds = ["mcp:shiba:gmail_read", "mcp:shiba:send_email"] as const;
  for (const [id, label, ids] of [
    ["runs", "Runs and status", runIds],
    ["email", "Gmail and email", emailIds],
  ] as const) {
    const states = policy ? ids.map((capability) => botCapabilityState(capability, policy)) : [];
    const on = states.filter((state) => state === "on").length;
    const available = states.filter((state) => state !== "ungranted").length;
    rows.push({
      id,
      label,
      detail: unknown
        ? (policyError ?? "Checking this bot's grants…")
        : available === 0
          ? "Not granted to this bot"
          : `${on} of ${ids.length} switched on · ${available} granted`,
      state: unknown ? "unknown" : available === 0 ? "ungranted" : on > 0 ? "on" : "off",
      href: "/settings/?section=employee-tools",
    });
  }

  return rows;
}

export const BOT_TOOL_STATE_LABEL: Record<BotToolState, string> = {
  on: "On",
  off: "Off",
  ungranted: "Not granted",
  workspace: "Workspace-wide",
  unavailable: "Unavailable",
  unknown: "Unknown",
};

/** A short count for the collapsed Tools row: only real per-bot capabilities count. */
export function botEnabledToolCount(rows: readonly BotToolRow[]): number {
  return rows.filter((row) => row.state === "on").length;
}

/**
 * Shiba is the workspace's default agent: it follows the workspace model and the
 * deployment's chat tools, and it has no per-bot tool policy. Its rows therefore
 * describe workspace-wide surfaces only, instead of borrowing a bot's grants.
 */
export function defaultAgentToolRows(options: { webSearchReady: boolean | null }): BotToolRow[] {
  const rows: BotToolRow[] = [{
    id: "web_search",
    label: "Web search",
    detail: options.webSearchReady === true
      ? "Provided by the workspace chat tools when a search key is configured."
      : options.webSearchReady === false
        ? "No search provider is configured on this deployment (WEB_SEARCH_API_KEY)."
        : "Reading the deployment's search setting…",
    state: options.webSearchReady === false ? "unavailable" : "workspace",
  }];
  for (const [id, label, href] of [
    ["memory", "Memory", "/memory"],
    ["knowledge", "Knowledge", "/files"],
    ["files", "Files", "/files"],
    ["notes", "Notes", "/notes"],
    ["skills", "Skills", "/skills"],
  ] as const) {
    rows.push({ id, label, detail: "Workspace-wide. Shiba has no per-bot switch for this surface.", state: "workspace", href });
  }
  return rows;
}
