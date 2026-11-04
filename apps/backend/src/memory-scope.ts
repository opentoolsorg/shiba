import { isDashboardAgentName, parseSessionAgentName } from "./web-sessions.js";

const SHARED_NAMES = new Set(["default", "global", "orchestrator-agent", "orchestrator", "system", "admin", "automation"]);

/** Accept only a server-authenticated conversation name, never model input. */
export function memoryScopeForConversation(name: string | undefined): string | null {
  if (!name || name !== name.trim() || name.length > 512 || Array.from(name).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return null;
  if (/^slack:[A-Za-z0-9_-]{1,128}:[A-Za-z0-9_-]{1,128}:\d{1,20}\.\d{1,20}$/.test(name)) return name;
  if (name.startsWith("slack:")) return null;
  const owner = parseSessionAgentName(name)?.userId ?? (isDashboardAgentName(name) ? name : null);
  return owner && !SHARED_NAMES.has(owner.toLowerCase()) ? owner : null;
}
