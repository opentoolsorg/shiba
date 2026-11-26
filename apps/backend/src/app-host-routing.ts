/** Lazy app-host path sets — built on first dashboard or marketing routing decision. */

let marketingSections: Set<string> | undefined;
let dashboardViews: Set<string> | undefined;

const MARKETING_SECTION_IDS = [
  "docs",
  "blog",
  "why-shiba",
  "privacy",
  "terms",
  "waitlist",
  "welcome",
] as const;

const DASHBOARD_VIEW_IDS = [
  "slack-canvas",
  "signin",
  "login",
  "",
  "work",
  "dashboard",
  "tasks",
  "threads",
  "activity",
  "analytics",
  "diff",
  "approvals",
  "swarm",
  "collaboration",
  "team",
  "agents",
  "inbox",
  "memory",
  "files",
  "notes",
  "projects",
  "outputs",
  "automations",
  "providers",
  "employee-tools",
  "integrations",
  "skills",
  "spaces",
  "chief-of-staff",
  "custom-agents",
  "remote",
  "settings",
] as const;

function marketingSectionsSet(): Set<string> {
  marketingSections ??= new Set(MARKETING_SECTION_IDS);
  return marketingSections;
}

function dashboardViewsSet(): Set<string> {
  dashboardViews ??= new Set(DASHBOARD_VIEW_IDS);
  return dashboardViews;
}

export function isMarketingSection(section: string): boolean {
  return marketingSectionsSet().has(section);
}

export function isDashboardViewPath(section: string, pathname: string): boolean {
  return dashboardViewsSet().has(section) && /^\/[^/]*\/?$/.test(pathname);
}

/** Sidebar view ids the app host shell serves — kept in sync with AppNavRail APP_NAV_ITEMS. */
export function getDashboardViews(): ReadonlySet<string> {
  return dashboardViewsSet();
}