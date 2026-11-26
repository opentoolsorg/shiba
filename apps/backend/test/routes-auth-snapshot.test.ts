/**
 * M08 prep — auth snapshot of every route the Worker serves today.
 *
 * For each request the table below records the EFFECTIVE unauthenticated
 * status the current index.ts chain produces. The M08 route-table refactor
 * must keep every one of these statuses identical; M09 then converts groups
 * to explicit AuthModes. See docs/proposals/target-architecture-2026-11.md
 * §14 (Security and routing) and §18 M08/M09.
 *
 * Env posture: Cloudflare Access configured (REQUIRE_ACCESS + ACCESS_AUD),
 * no better-auth secret, webhook shared secrets SET so signature checks —
 * not the "webhook disabled" 503 — are what rejects a bare request.
 * ASSETS/DO bindings are stubs; statuses that depend on them are marked.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import worker from "../src/index.js";
import { TEST_ACCESS_AUD } from "./fixtures/access-identity.js";

afterEach(() => vi.unstubAllGlobals());

vi.mock("@cloudflare/sandbox", () => ({
  Sandbox: class {},
  ContainerProxy: class {},
  proxyToSandbox: vi.fn().mockResolvedValue(null),
  getSandbox: vi.fn(),
}));
vi.mock("agents/routing", () => ({
  getAgentByName: vi.fn(),
  routeAgentRequest: vi.fn().mockResolvedValue(null),
}));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
vi.mock("../src/agents/orchestrator.js", () => ({ CodingOrchestrator: class {} }));

// --- Binding fakes ---------------------------------------------------------

class FakeKV {
  rows = new Map<string, string>();
  async get(key: string) { return this.rows.get(key) ?? null; }
  async put(key: string, value: string) { this.rows.set(key, value); }
  async delete(key: string) { this.rows.delete(key); }
  async list() {
    return { keys: [...this.rows.keys()].map((name) => ({ name })), list_complete: true, cacheStatus: null };
  }
}

function fakeD1(): D1Database {
  const statement = {
    bind: () => statement,
    run: async () => ({ success: true, meta: {} }),
    first: async () => null,
    all: async () => ({ results: [], success: true, meta: {} }),
  };
  return { prepare: () => statement } as unknown as D1Database;
}

/** Mirrors the Automations DO's auth-relevant answers for bare requests. */
function fakeAutomationsNamespace(): DurableObjectNamespace {
  const stub = {
    fetch: async (request: Request) => {
      const { pathname } = new URL(request.url);
      if (/^\/api\/automations\/[^/]+\/trigger\/?$/.test(pathname)) {
        return request.method === "POST"
          ? Response.json({ error: "Invalid automation secret." }, { status: 401 })
          : Response.json({ error: "Not found." }, { status: 404 });
      }
      if (pathname === "/internal/internal/dedupe") {
        return Response.json({ seen: false });
      }
      return Response.json({ error: "Not found." }, { status: 404 });
    },
  };
  return {
    idFromName: (name: string) => name,
    get: () => stub,
  } as unknown as DurableObjectNamespace;
}

function fixture(overrides: Record<string, unknown> = {}): Env {
  return {
    REQUIRE_ACCESS: "1",
    ACCESS_AUD: TEST_ACCESS_AUD,
    AGENT_AUDIT: fakeD1(),
    AGENT_TOKENS: new FakeKV() as unknown as KVNamespace,
    OAUTH_RATE_LIMIT: { limit: async () => ({ success: true }) } as unknown as RateLimit,
    Automations: fakeAutomationsNamespace(),
    Waitlist: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => Response.json({ ok: true }) }),
    } as unknown as DurableObjectNamespace,
    // The worker rewrites dashboard shells to /app/; treat that plus the
    // public static surface as existing assets, everything else as a 404 —
    // matching what the real binding does for unknown paths.
    ASSETS: {
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname;
        const known =
          path === "/app" || path === "/app/" || path.startsWith("/app/")
          || path === "/" || path === "/index.html"
          || path === "/favicon.ico" || path === "/favicon.svg" || path === "/favicon-32x32.png"
          || path === "/robots.txt" || path === "/sitemap.xml" || path === "/sitemap-index.xml"
          || path === "/sitemap-0.xml" || path === "/llms.txt" || path === "/404.html"
          || path.startsWith("/_astro/") || path.startsWith("/assets/") || path.startsWith("/pagefind/");
        return new Response(known ? "asset" : "not found", { status: known ? 200 : 404 });
      },
    } as unknown as Fetcher,
    // Webhook secrets ON so the signature/token check — not the disabled
    // 503 — is the effective unauthenticated response.
    SLACK_SIGNING_SECRET: "slack-signing-secret-for-tests",
    GITHUB_WEBHOOK_SECRET: "github-webhook-secret-for-tests",
    LINEAR_WEBHOOK_SECRET: "linear-webhook-secret-for-tests",
    SENTRY_WEBHOOK_SECRET: "sentry-webhook-secret-for-tests",
    TELEGRAM_BOT_TOKEN: "123456:telegram-bot-token-for-tests",
    TELEGRAM_WEBHOOK_SECRET: "telegram-webhook-secret-for-tests",
    DISCORD_PUBLIC_KEY: "discord-public-key-for-tests",
    TRIGGER_TOKEN: "t".repeat(64),
    ...overrides,
  } as Env;
}

interface RouteCase {
  method: string;
  path: string;
  status: number;
  /** Request extras: headers, body, content-type. */
  init?: { headers?: Record<string, string>; body?: string };
  note?: string;
}

const get = (path: string, status: number, note?: string): RouteCase => ({ method: "GET", path, status, note });
const post = (path: string, status: number, note?: string, init?: RouteCase["init"]): RouteCase => ({
  method: "POST", path, status, note, init,
});

// ---------------------------------------------------------------------------
// The snapshot. Grouped by the M09 conversion lanes; order mirrors index.ts.
// ---------------------------------------------------------------------------

const ROUTES: RouteCase[] = [
  // -- Pre-gate: founder automatic-read capability permit (index.ts:293) --
  { method: "GET", path: "/internal/founder-automatic-read/permit", status: 403, note: "pre-gate; non-POST forbidden" },
  post("/internal/founder-automatic-read/permit", 403, "pre-gate; bad capability", {
    headers: { "content-type": "application/json" },
    body: "{}",
  }),

  // -- Pre-gate: artifact download — signed-capability auth (artifact-download.ts) --
  get("/api/artifacts/download", 403, "no token → invalid/expired"),
  get("/api/artifacts/download?landing=1", 200, "landing page is public HTML"),
  post("/api/artifacts/download", 403, "no token → invalid/expired"),

  // -- Pre-gate: Slack OAuth install callback (index.ts:321) --
  get("/api/slack/installations/callback", 503, "pre-gate; OAuth env unset → operator_setup_required"),

  // -- Pre-gate: dev OAuth loopback (dev-only host+secret) --
  get("/api/dev/oauth-loopback", 404, "non-loopback host → not found"),
  post("/api/dev/oauth-loopback", 404, "non-loopback host → not found"),

  // -- Pre-gate: marketing sections → tryshiba.dev (GET/HEAD only) --
  get("/docs/overview", 301, "marketing redirect"),
  get("/blog/launch", 301, "marketing redirect"),
  get("/why-shiba", 301, "marketing redirect"),
  get("/privacy", 301, "marketing redirect"),
  get("/terms", 301, "marketing redirect"),
  get("/waitlist", 301, "marketing page redirect (the API is /api/waitlist)"),
  get("/welcome", 301, "marketing redirect"),
  post("/docs/overview", 401, "non-GET marketing path hits the identity gate"),

  // -- Pre-gate: dashboard shells served from ASSETS before the gate --
  get("/", 200, "DASHBOARD_VIEWS '' → /app/ shell"),
  get("/work", 200, "dashboard view shell"),
  get("/signin", 200, "dashboard view shell"),
  get("/settings", 200, "dashboard view shell"),
  get("/threads", 200, "dashboard view shell"),
  get("/auth/forgot", 200, "WS02 password-reset shell"),
  get("/auth/reset", 200, "WS02 password-reset shell"),
  get("/spaces/ws_0123456789abcdef01234567", 200, "space page shell"),
  get("/share/c/sometoken", 200, "share page shell (client resolves via API)"),
  get("/share/f/sometoken", 200, "share page shell"),
  get("/app", 401, "NOT a dashboard view id — gated"),
  get("/app/", 401, "gated unless OPEN_DASHBOARD=1"),

  // -- Pre-gate: handleShare first pass (share-routes.ts) --
  get("/api/share/file/not-a-real-token", 404, "public share-file lookup; unknown token → 404"),
  post("/api/share", 401, "handler's own isAuthorizedRequest check"),
  get("/api/share", 405, "handler: POST only"),

  // -- Identity gate: every non-exempt path → 401 -------------------------
  // Representative gated paths, one+ per post-gate handler in index.ts order.
  get("/api/approvals", 401, "approvals-routes"),
  get("/api/activity", 401, "activity-routes"),
  get("/api/audit", 401, "audit-routes"),
  get("/api/usage", 401, "usage-routes"),
  get("/api/whoami", 401, "meta-routes"),
  get("/api/setup/status", 401, "meta-routes"),
  get("/api/setup/wizard", 401, "meta-routes"),
  post("/api/setup/fix", 401, "meta-routes"),
  get("/api/agents", 401, "meta-routes"),
  get("/api/model-config", 401, "meta-routes → ModelConfig DO"),
  get("/api/model-config/connections", 401, "meta-routes → ModelConfig DO"),
  get("/api/email/openapi.json", 401, "meta-routes"),
  get("/api/email/delivery-status", 401, "email/routes (also needs operator)"),
  get("/api/health", 200, "PUBLIC: isPublicRequest GET /api/health"),
  post("/api/health", 401, "POST not in the public exemption"),
  get("/api/runs", 401, "runs-routes"),
  post("/api/runs", 401, "runs-routes intake"),
  get("/api/runs/run_123/proof", 401, "runs-routes proof"),
  post("/api/runs/run_123/steer", 401, "runs-routes steer"),
  get("/api/runs/run_123/deliverables/file_1", 401, "runs-routes deliverable"),
  post("/api/runs/run_123/deliverables/file_1/review", 401, "runs-routes deliverable action"),
  get("/api/runs/env-seal", 401, "runs-routes env-seal"),
  post("/api/runs/attachments", 401, "runs-routes attachments"),
  get("/api/spine", 401, "runs-routes spine"),
  get("/api/tasks/task_1", 401, "runs-routes tasks"),
  post("/api/tasks/task_1/retry", 401, "runs-routes tasks"),
  get("/api/employee-drafts", 401, "runs-routes employee drafts"),
  get("/api/employee-drafts/draft_1/download", 401, "runs-routes draft download"),
  get("/api/runs/run_1/ask-user/pending", 401, "ask-user-routes"),
  post("/api/runs/run_1/ask-user/q_1/answer", 401, "ask-user-routes"),
  get("/api/swarm/intake", 401, "swarm-routes"),
  post("/api/swarm/intake", 401, "swarm-routes"),
  get("/api/swarm/share", 401, "swarm-routes share mint"),
  get("/api/swarm/share/shr_1", 401, "swarm-routes share resolve"),
  get("/api/dens/den_1", 401, "den-routes"),
  get("/api/captains/cap_1", 401, "den-routes legacy prefix"),
  get("/api/sandboxes/sbx_1/info", 401, "sandbox-routes"),
  post("/api/sandboxes/sbx_1/exec", 401, "sandbox-routes"),
  post("/api/voice/transcribe", 401, "voice-routes"),
  get("/api/screenshots/sh_1", 401, "screenshots-routes"),
  get("/api/e2e-evidence/ev_1/report.json", 401, "e2e-evidence-routes"),
  get("/api/sessions", 401, "sessions-routes"),
  post("/api/sessions", 401, "sessions-routes"),
  get("/api/sessions/ses_1", 401, "sessions-routes"),
  post("/api/sessions/ses_1/resume", 401, "sessions-routes"),
  get("/api/sessions/ses_1/realtime", 401, "sessions-routes realtime"),
  get("/api/rooms/room_1/websocket", 401, "sessions-routes room alias"),
  get("/api/mailboxes", 401, "inbox-routes"),
  get("/api/emails", 401, "inbox-routes"),
  get("/api/emails-search", 401, "inbox-routes"),
  get("/api/emails/mail_1", 401, "inbox-routes"),
  get("/api/emails/mail_1/attachments/att_1", 401, "inbox-routes"),
  post("/api/emails/mail_1/read", 401, "inbox-routes"),
  get("/api/drafts", 401, "inbox-routes"),
  post("/api/drafts/draft_1/send", 401, "inbox-routes"),
  get("/api/threads/thr_1", 401, "inbox-routes thread"),
  get("/api/memory/facts", 401, "memory-routes"),
  get("/api/memory/facts/fact_1", 401, "memory-routes"),
  get("/api/memory/sessions", 401, "memory-routes"),
  get("/api/memory/sources", 401, "memory-routes"),
  get("/api/memory/sources/src_1/download", 401, "memory-routes"),
  post("/api/memory/sources/upload", 401, "memory-routes"),
  get("/api/memory/projects", 401, "memory-routes"),
  post("/api/memory/recall", 401, "memory-routes"),
  get("/api/files", 401, "files-routes"),
  get("/api/files/folders", 401, "files-routes"),
  post("/api/files/uploads", 401, "files-routes"),
  get("/api/files/file_1", 401, "files-routes"),
  get("/api/files/file_1/download", 401, "files-routes"),
  get("/api/notes", 401, "notes-routes"),
  get("/api/notes/note_1", 401, "notes-routes"),
  get("/api/notes/note_1/body", 401, "notes-routes"),
  post("/api/knowledge/search", 401, "knowledge-routes"),
  get("/api/projects", 401, "knowledge-projects-routes"),
  get("/api/outputs", 401, "knowledge-outputs-routes"),
  get("/api/outputs/out_1/download", 401, "knowledge-outputs-routes"),
  get("/api/slack-canvas", 401, "slack-canvas-routes"),
  get("/api/slack-canvas/websocket", 401, "slack-canvas-routes websocket"),
  get("/api/capabilities", 401, "capability-catalog-routes"),
  get("/api/capabilities/invocations", 401, "capability-catalog-routes"),
  post("/api/webhooks/subscriptions", 401, "webhooks/routes"),
  get("/api/webhooks/subscriptions", 401, "webhooks/routes"),
  post("/api/webhooks/validate-url", 401, "webhooks/routes"),
  get("/api/webhooks/events", 401, "webhooks/routes"),
  get("/api/integrations/slack/verify", 401, "integrations-routes (POST route; GET gated)"),
  post("/api/integrations/slack/verify", 401, "integrations-routes"),
  get("/api/integrations/github/status", 401, "integrations-routes"),
  get("/api/integrations/linear/status", 401, "integrations-routes"),
  get("/api/integrations/provider/meta", 401, "integrations-provider-routes"),
  post("/api/integrations/provider/execute", 401, "integrations-provider-routes"),
  get("/api/operator-enrollment-reviews", 401, "operator-enrollment-routes"),
  post("/api/operator-enrollment-reviews/oe_1/decision", 401, "operator-enrollment-routes"),
  get("/api/v1/threads", 401, "v1-routes (non-org path → Access gate)"),
  get("/api/v1/capabilities", 401, "v1-routes bearerSafe but still gated"),
  get("/api/v1/model-providers", 401, "v1-routes"),
  get("/api/v1/org-agents", 401, "v1-routes"),
  get("/api/v1/usage", 401, "v1-routes"),
  get("/api/v1/openapi.json", 200, "PUBLIC: isPublicRequest GET openapi"),
  post("/api/v1/openapi.json", 401, "POST not exempt"),
  get("/api/connections/gmail", 401, "gmail-routes"),
  post("/api/connections/gmail/begin", 401, "gmail-routes"),
  get("/api/providers", 401, "acp-provider-routes"),
  get("/api/providers/gemini", 401, "acp-provider-routes"),
  get("/api/auth/codex-subscription/status", 401, "auth-routes subscription lane (excluded from better-auth path)"),
  get("/api/auth/claude-subscription/status", 401, "auth-routes"),
  get("/api/antigravity/callback", 401, "auth-routes"),
  get("/api/subscription/openai/status", 401, "subscription-auth-routes"),
  post("/api/subscription/openai/connect", 401, "subscription-auth-routes"),
  get("/api/waitlist", 401, "waitlist: only POST is public"),
  get("/api/admin/waitlist", 401, "waitlist admin — gated"),
  get("/api/admin/flags", 401, "flag registry admin — gated"),
  post("/api/waitlist", 403, "PUBLIC POST but Origin header required"),
  get("/api/first-run-seed", 401, "first-run-seed"),
  post("/api/first-run-seed", 401, "first-run-seed"),
  post("/api/employee-bundles/export", 401, "employee-bundles-routes"),
  post("/api/employee-bundles/preview", 401, "employee-bundles-routes"),
  post("/api/employee-bundles/import", 401, "employee-bundles-routes"),
  get("/api/workspace-integrations", 401, "workspace-integrations-routes"),
  post("/api/workspace-integrations/wsi_1/test", 401, "workspace-integrations-routes"),
  get("/api/personal-execution/harness", 401, "personal-execution-routes"),
  post("/api/personal-execution/harness/decide", 401, "personal-execution-routes"),
  get("/api/personal-execution/computers", 401, "personal-execution-routes"),
  get("/api/team-model-sessions", 401, "team-model-routes"),
  get("/api/workspaces", 401, "team-workspaces-routes"),
  get("/api/workspaces/ws_1", 401, "team-workspaces-routes"),
  get("/api/workspaces/ws_1/events", 401, "workspace-events-routes"),
  get("/api/workspaces/ws_1/work", 401, "team-work-routes"),
  post("/api/workspaces/ws_1/work/task_1/archive", 401, "team-work-routes"),
  get("/api/workspaces/ws_1/primary-bot", 401, "collaboration-primary-bot-routes"),
  get("/api/needs-you", 401, "team-work-routes"),
  get("/api/collaboration/rooms/room_1", 401, "collaboration-room-routes"),
  get("/api/collaboration/rooms/room_1/realtime", 401, "collaboration-room-routes realtime"),
  get("/api/collaboration/handoffs/h_1/artifacts/0", 401, "collaboration-room-routes"),
  get("/api/workspace-notifications", 401, "notifications-routes"),
  get("/api/slack-import", 401, "slack-import-routes"),
  post("/api/slack-import/bindings", 401, "slack-import-routes"),
  get("/api/computers", 401, "computers-routes"),
  post("/api/computers/pairing-token", 401, "computers-routes"),
  get("/api/computers/harness", 401, "computers-routes"),
  get("/api/slack/coworker", 401, "slack-coworker-routes"),
  get("/api/slack/coworker/drafts", 401, "slack-coworker-routes"),
  get("/api/shared-computers", 401, "shared-computer-routes"),
  get("/api/shared-computers/state", 401, "shared-computer-routes"),
  post("/api/shared-computers/sessions/prepare", 401, "shared-computer-routes"),
  get("/api/governance/admin/workspaces", 401, "governance-routes"),
  get("/api/governance/admin/audit", 401, "governance-routes"),
  get("/api/onboarding/progress", 401, "onboarding-progress"),
  get("/api/onboarding/progress/team-task", 401, "team-onboarding-task"),
  get("/api/search", 401, "search-routes"),
  get("/api/palette/bots", 401, "palette-routes"),
  post("/api/palette/pins/1", 401, "palette-routes"),
  // Founder/* family — all behind the same Access gate.
  get("/api/founder-skills", 401, "founder-skills-routes"),
  post("/api/founder-skills/fsk_1/install", 401, "founder-skills-routes"),
  get("/api/founder-skills/fsk_1/connector-job", 401, "founder-connector-routes"),
  get("/api/founder-skills/fsk_1/reports", 401, "founder-evidence-routes"),
  get("/api/founder-skills/fsk_1/reports/rpt_1/slack", 401, "report-slack-routes"),
  get("/api/founder-skills/fsk_1/automatic-reads", 401, "founder-auto-read-routes"),
  get("/api/founder-skills/fsk_1/automatic-slack", 401, "founder-automatic-slack-routes"),
  get("/api/founder-stripe-reads", 401, "founder-stripe-routes"),
  get("/api/founder-meta-reads", 401, "founder-meta-routes"),
  get("/api/founder-hubspot-reads", 401, "founder-hubspot-routes"),
  get("/api/founder-reconciliations", 401, "founder-reconciliation-routes"),
  get("/api/founder-reconciliation-schedules", 401, "founder-reconciliation-schedule-routes"),
  get("/api/founder-reconciliation-slack", 401, "founder-reconciliation-slack-routes"),
  get("/api/founder-stripe-slack", 401, "founder-automatic-slack-stripe-routes"),
  get("/agents/coding-orchestrator/some-agent", 401, "DO route — gated before agent fetch"),
  get("/agents/coding-orchestrator", 401, "DO route root — gated"),
  get("/agents/opencode-agent/x", 401, "routeAgentRequest — gated"),
  get("/internal/mailbox/inbox", 401, "internal paths gated like everything else"),
  get("/api/definitely-not-a-route", 401, "unmatched /api/* hits the identity gate before the JSON-404 fallback"),
  get("/not-a-real-page", 401, "unknown non-api path hits the identity gate first"),

  // -- Org-scoped API paths: exempt from the Access gate, self-auth inside -
  get("/api/api-keys", 401, "api-keys-routes → authorizeV1Request"),
  post("/api/api-keys", 401, "api-keys-routes"),
  get("/api/custom-agents", 401, "custom-agents-routes → resolveOrgForApiRequest"),
  post("/api/custom-agents", 401, "custom-agents-routes"),
  get("/api/employee-tools", 401, "employee-tool-routes"),
  post("/api/employee-tools/tool_1/call", 401, "employee-tool-routes"),
  get("/api/reason-network", 401, "reason-network/routes"),
  get("/api/skills/library", 401, "skill-library-routes"),
  post("/api/skills/library/skill_1/install", 401, "skill-library-routes"),
  get("/api/skills", 401, "skills-routes — /api/skills is NOT an org path, gated"),
  get("/api/skills/skill_1", 401, "skills-routes"),
  get("/api/spaces", 401, "spaces-routes → resolveOrgForApiRequest"),
  get("/api/spaces/space_1/items", 401, "spaces-routes"),
  get("/api/org/sandbox", 401, "org-sandbox-routes"),
  post("/api/org/sandbox/test", 401, "org-sandbox-routes"),
  get("/api/org/model-keys", 401, "org-model-keys-routes"),
  post("/api/org/model-keys/test", 401, "org-model-keys-routes"),
  get("/api/v1/extensions/skills", 401, "v1 extension-skills → authorizeV1Request"),
  get("/api/v1/runs", 401, "api-keys-routes v1Runs lane → authorizeV1Request → null → falls to v1 gate"),

  // -- Webhook lane: exempt from the gate, signature/secret inside ---------
  post("/api/slack/events", 401, "slack signature (multi-installation gate or legacy)", {
    headers: { "content-type": "application/json" }, body: "{}",
  }),
  get("/api/slack/events", 405, "SIGNATURE_AUTHENTICATED non-POST → 405"),
  post("/api/slack/command", 401, "slack signature", {
    headers: { "content-type": "application/x-www-form-urlencoded" }, body: "command=/shiba",
  }),
  post("/api/slack/interact", 401, "slack signature", {
    headers: { "content-type": "application/x-www-form-urlencoded" }, body: "payload=%7B%7D",
  }),
  post("/api/github/webhook", 401, "HMAC signature", {
    headers: { "content-type": "application/json" }, body: "{}",
  }),
  get("/api/github/webhook", 405, "SIGNATURE_AUTHENTICATED non-POST → 405"),
  post("/api/linear/webhook", 401, "Linear signature", {
    headers: { "content-type": "application/json" }, body: "{}",
  }),
  get("/api/linear/webhook", 405, "SIGNATURE_AUTHENTICATED non-POST → 405"),
  post("/api/discord/interactions", 401, "ed25519 signature", {
    headers: { "content-type": "application/json" }, body: "{}",
  }),
  post("/api/telegram/webhook", 401, "secret-token header", {
    headers: { "content-type": "application/json" }, body: "{}",
  }),
  post("/api/sentry/webhook", 401, "sentry-hook-signature / token", {
    headers: { "content-type": "application/json" }, body: "{}",
  }),
  get("/api/sentry/webhook", 405, "SIGNATURE_AUTHENTICATED non-POST → 405"),
  post("/api/trigger", 401, "TRIGGER_TOKEN bearer", {
    headers: { "content-type": "application/json" }, body: "{}",
  }),
  post("/api/automations/auto_1/trigger", 401, "per-automation webhook secret (DO)"),
  get("/api/automations/auto_1/trigger", 404, "webhook path any-method exempt; DO 404s non-POST"),
  get("/api/automations", 401, "non-webhook automation path → Access gate"),
  post("/api/automations/auto_1/run", 401, "manual run is NOT a webhook path → Access gate"),

  // -- MCP + OAuth + local-daemon lane -------------------------------------
  post("/mcp", 401, "bearer:mcp — missing token", {
    headers: { "content-type": "application/json" }, body: "{}",
  }),
  get("/mcp", 401, "bearer:mcp — GET also bearer-gated"),
  post("/mcp/tools/list", 401, "bearer:mcp subpath"),
  get("/.well-known/oauth-authorization-server", 200, "public OAuth discovery (RFC 8414)"),
  get("/.well-known/oauth-protected-resource", 200, "public OAuth discovery (RFC 9728)"),
  post("/oauth/register", 400, "public registration; empty metadata → 400", {
    headers: { "content-type": "application/json" }, body: "{}",
  }),
  get("/oauth/register", 404, "GET not handled → ASSETS 404 (stub)"),
  get("/oauth/authorize", 401, "consent screen gated; JSON accept → 401"),
  {
    method: "GET", path: "/oauth/authorize", status: 302,
    note: "consent screen with HTML accept → sign-in redirect",
    init: { headers: { accept: "text/html" } },
  },
  post("/oauth/authorize", 401, "consent POST gated"),
  post("/oauth/token", 400, "public token endpoint; empty form → unsupported_grant_type", {
    headers: { "content-type": "application/x-www-form-urlencoded" }, body: "",
  }),
  post("/oauth/revoke", 200, "RFC 7009 — always 200"),
  get("/oauth/token", 404, "GET not handled → ASSETS 404 (stub)"),
  post("/api/local/claim", 404, "SHIBA_LOCAL_RUNTIME unset → 404"),
  get("/api/local/pending", 404, "SHIBA_LOCAL_RUNTIME unset → 404"),
  post("/api/local/pair", 404, "SHIBA_LOCAL_RUNTIME unset → 404"),
  post("/api/local/events", 404, "SHIBA_LOCAL_RUNTIME unset → 404"),
];

describe("route auth snapshot — unauthenticated requests (Access-configured env)", () => {
  it.each(ROUTES)("$method $path → $status", async ({ method, path, status, init }) => {
    const request = new Request(`https://worker.test${path}`, {
      method,
      headers: init?.headers,
      body: init?.body,
    });
    const response = await worker.fetch(request, fixture());
    expect(response.status, `${method} ${path}`).toBe(status);
  });
});

describe("route auth snapshot — OPEN_DASHBOARD=1", () => {
  const OPEN_DASHBOARD_ROUTES: RouteCase[] = [
    get("/app", 200, "OPEN_DASHBOARD exempts /app GET → ASSETS (stub 200)"),
    get("/app/", 200, "OPEN_DASHBOARD exempts /app/ GET → ASSETS (stub 200)"),
    get("/app/settings", 200, "OPEN_DASHBOARD exempts /app/* GET → ASSETS (stub 200)"),
    post("/app/", 401, "exemption is GET/HEAD only"),
    get("/api/app", 401, "only /, /app, /app/*, /assets/* are exempt — not /api/*"),
  ];
  it.each(OPEN_DASHBOARD_ROUTES)("$method $path → $status", async ({ method, path, status }) => {
    const request = new Request(`https://worker.test${path}`, { method });
    const response = await worker.fetch(request, fixture({ OPEN_DASHBOARD: "1" }));
    expect(response.status, `${method} ${path}`).toBe(status);
  });
});
