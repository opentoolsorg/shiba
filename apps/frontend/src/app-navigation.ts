export type AppNavView =
  | "work"
  | "dashboard"
  | "tasks"
  | "threads"
  | "activity"
  | "analytics"
  | "diff"
  | "approvals"
  | "swarm"
  | "collaboration"
  | "team"
  | "agents"
  | "inbox"
  | "memory"
  | "files"
  | "notes"
  | "projects"
  | "outputs"
  | "automations"
  | "providers"
  | "integrations"
  | "skills"
  | "spaces"
  | "custom-agents"
  | "employee-tools"
  | "remote"
  | "settings";

export interface AppNavItem {
  id: AppNavView;
  label: string;
  description: string;
}

export const APP_NAV_ITEMS: AppNavItem[] = [
  { id: "work", label: "Work", description: "Tasks, Board & Timeline" },
  { id: "tasks", label: "Tasks", description: "Agent task queues & handoff" },
  { id: "threads", label: "Threads", description: "Conversations & Live Sessions" },
  { id: "diff", label: "Pull requests", description: "Code Changes & Git Diffs" },
  { id: "automations", label: "Automations", description: "Automations & Triggers" },
  { id: "dashboard", label: "Dashboard", description: "Overview & At-a-Glance Stats" },
  { id: "activity", label: "Activity", description: "Workspace activity & event log" },
  { id: "analytics", label: "Analytics", description: "Usage & Run Insights" },
  { id: "approvals", label: "Approvals", description: "Review & Decision Queue" },
  { id: "swarm", label: "Swarm", description: "Run Lanes, Modes & Share Links" },
  {
    id: "collaboration",
    label: "Collaboration",
    description: "Private rooms for people and agents",
  },
  { id: "team", label: "Team", description: "Workspaces, members and invitations" },
  { id: "providers", label: "Providers", description: "Connect AI Coding Agents" },
  { id: "skills", label: "Skills", description: "Your Saved Skills" },
  { id: "spaces", label: "Spaces", description: "Hosted coworker mini-apps" },
  { id: "custom-agents", label: "Agents", description: "Reusable agents, instructions & defaults" },
  { id: "employee-tools", label: "Tool policy", description: "Employee tool grants & approvals" },
  { id: "agents", label: "MCP", description: "Client configuration, gateway & agent tokens" },
  { id: "inbox", label: "Mailbox", description: "Cloudflare Email Routing & Send" },
  { id: "memory", label: "Memory", description: "Vectorize Long-Term Semantic Memory" },
  { id: "files", label: "Files", description: "Folders, uploads and document previews" },
  { id: "notes", label: "Notes", description: "Markdown notes with slash commands" },
  { id: "projects", label: "Projects", description: "Group files and notes" },
  { id: "outputs", label: "Outputs", description: "Run deliverables and generated media" },
  {
    id: "integrations",
    label: "Integrations",
    description: "Providers, Channels & Platform Services",
  },
  { id: "remote", label: "Remote Access", description: "Paired Local Computers & Daemon Fleet" },
  { id: "settings", label: "Settings", description: "Deployment & Operator Settings" },
];

export type AppArea = "work" | "chat" | "team" | "knowledge" | "settings";
export const APP_AREAS: readonly {
  id: AppArea;
  label: string;
  defaultView: AppNavView;
  views: readonly AppNavView[];
}[] = [
  {
    id: "work",
    label: "Work",
    defaultView: "work",
    views: ["work", "tasks", "approvals", "diff", "swarm", "dashboard"],
  },
  { id: "chat", label: "Chat", defaultView: "threads", views: ["threads", "collaboration"] },
  {
    id: "team",
    label: "Team",
    defaultView: "custom-agents",
    views: ["custom-agents", "employee-tools", "providers", "skills", "agents", "team"],
  },
  { id: "knowledge", label: "Knowledge", defaultView: "memory", views: ["memory", "files", "notes", "projects", "outputs", "spaces"] },
  {
    id: "settings",
    label: "Settings",
    defaultView: "settings",
    views: ["settings", "integrations", "inbox", "automations", "activity", "analytics", "remote"],
  },
];
export function areaForView(view: AppNavView) {
  const area = APP_AREAS.find((item) => item.views.includes(view));
  if (!area) throw new Error(`Unmapped dashboard view: ${view}`);
  return area;
}
const VIEW_ALIASES: Record<string, AppNavView> = {
  "run-registry": "analytics",
  orchestrator: "activity",
  mailbox: "inbox",
};
export function isAppNavView(raw: string | null): raw is AppNavView {
  return APP_NAV_ITEMS.some((item) => item.id === raw);
}
function readView(raw: string | null): AppNavView | null {
  const view = raw ? (VIEW_ALIASES[raw] ?? raw) : null;
  return isAppNavView(view) ? view : null;
}
/** Deployed flat paths are canonical. Nested aliases need a Worker fallback first. */
export function pathForView(view: AppNavView): string {
  return `/${view}/`;
}
export function readNavigationView(pathname: string, search: string): AppNavView | null {
  const params = new URLSearchParams(search);
  const pathView = readView(pathname.split("/")[1] ?? null);
  // Work's layout uses ?view=; it is not the legacy destination selector.
  if (
    params.has("task") ||
    ["list", "board", "timeline", "organization"].includes(params.get("view") ?? "")
  )
    return "work";
  return pathView ?? readView(params.get("tab")) ?? readView(params.get("view"));
}

/** Destination labels distinguish a surface from its containing area. */
export function navigationLabel(view: AppNavView): string {
  const labels: Partial<Record<AppNavView, string>> = {
    work: "Board & timeline",
    settings: "General",
    team: "Members",
    collaboration: "Rooms",
  };
  return labels[view] ?? APP_NAV_ITEMS.find((item) => item.id === view)?.label ?? view;
}
