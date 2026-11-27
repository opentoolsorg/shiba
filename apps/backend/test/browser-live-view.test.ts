import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { runInNewContext } from "node:vm";
import { generateText, type ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { createTeamWorkspace } from "../src/team-workspaces-store.js";
import { BrowserSession } from "../src/tools/browser-session-do.js";
import { handleBrowserLogins, handleBrowserSession } from "../src/tools/browser-routes.js";
import { browserLoginCode } from "../src/tools/browser-sign-in.js";
import { browserCommand, chatBrowserKey, type BrowserCommand } from "../src/tools/browser-sessions.js";
import { createChatAgentMediaTools } from "../src/tools/chat-agent-tools.js";
import { registerAgentMediaMcpTools } from "../src/tools/register-mcp.js";
import { buildSessionAgentName } from "../src/web-sessions.js";
import { applyAllMigrations } from "./fixtures/all-migrations.js";

const { acquire, connect } = vi.hoisted(() => ({ acquire: vi.fn(), connect: vi.fn() }));
vi.mock("@cloudflare/puppeteer", () => ({ default: { acquire, connect } }));

const app = "https://dashboard.example.test";
const site = "https://accounts.example.test";
const owner = "owner@example.test";
const outsider = "outsider@example.test";
const browserKey = chatBrowserKey(owner);
const password = crypto.randomUUID();
const fakeSeed = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const databases: DatabaseSync[] = [];

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
});

function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  applyAllMigrations(db);
  const prepare = (sql: string, values: SQLInputValue[] = []) => ({
    bind: (...next: SQLInputValue[]) => prepare(sql, next),
    all: async () => ({ results: db.prepare(sql).all(...values) }),
    first: async () => db.prepare(sql).get(...values) ?? null,
    run: async () => ({ meta: db.prepare(sql).run(...values) }),
  });
  const table = new Map<string, unknown>();
  const storage = {
    get: async (key: string) => structuredClone(table.get(key)),
    put: async (key: string, value: unknown) => { table.set(key, structuredClone(value)); },
    delete: async (key: string) => table.delete(key),
    setAlarm: vi.fn(),
  };
  const env = {
    REQUIRE_ACCESS: "1", AGENT_AUDIT: { prepare, batch: async (commands: ReturnType<typeof prepare>[]) => Promise.all(commands.map((cmd) => cmd.run())) },
    MODEL_CREDENTIAL_KEY: "ab".repeat(32), VAULT_WRITE_V2: "1",
    BROWSER: {}, BrowserSession: {
      idFromName: (id: string) => id,
      get: vi.fn((id: string) => ({
        fetch: async (url: string, init: RequestInit) => id === browserKey
          ? new BrowserSession({ storage } as never, env).fetch(new Request(url, init))
          : Response.json({ state: "none" }),
      })),
    },
  } as unknown as Env;
  const response = (command: BrowserCommand) => new BrowserSession({ storage } as never, env).fetch(
    new Request("https://browser-session.internal/command", { method: "POST", body: JSON.stringify(command) }),
  );
  const command = async <T>(value: BrowserCommand) => browserCommand<T>(env, browserKey, value);
  return { env, db, table, storage, command, response };
}

function request(path: string, { actor = owner, method = "GET", body, origin = app, authorization }: {
  actor?: string; method?: string; body?: unknown; origin?: string; authorization?: string;
} = {}) {
  const headers = new Headers({ "content-type": "application/json", origin });
  if (actor) headers.set("Cf-Access-Authenticated-User-Email", actor);
  if (authorization) headers.set("authorization", authorization);
  return new Request(`${app}${path}`, { headers, method, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function createLogin(env: Env) {
  const result = await handleBrowserLogins(request("/api/browser-logins", {
    method: "POST", body: { label: "Vendor console", origin: site, username: "operator", password, totpSecret: fakeSeed },
  }), env);
  expect(result.status).toBe(201);
  const { login } = await result.json() as { login: { id: string } };
  return login.id;
}

function rendering(initialUrl = site) {
  let address = initialUrl;
  let echoed = "";
  const submit = vi.fn<(fields: string[]) => void>();
  const cdp = {
    send: vi.fn(async (method: string, data?: { functionDeclaration: string; arguments: Array<{ value: Record<string, unknown> }> }) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "top-frame" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 4 };
      const fields = data!.arguments[0]!.value;
      class Input {
        value = "";
        readOnly = false;
        form?: Form;
        constructor(public name: string, public type: string, public autocomplete: string) {}
        matches() { return false; }
        getClientRects() { return [1]; }
      }
      class Form {
        method = "post";
        elements: Input[] = [];
        matches() { return false; }
        getAttribute(name: string) { return name === "action" ? "/session" : null; }
        submit() {
          submit(this.elements.map((field) => field.value));
          echoed = `Fake echo: ${fields.password} ${fields.code} ${fakeSeed}`;
        }
      }
      const form = new Form();
      const secret = new Input("password", "password", "current-password");
      secret.form = form;
      form.elements = [new Input("login", "email", "username"), secret, new Input("code", "text", "one-time-code")];
      const result: unknown = runInNewContext(`(${data!.functionDeclaration})(fields)`, {
        fields, URL, location: new URL(address), getComputedStyle: () => ({ visibility: "visible" }),
        document: { baseURI: address, querySelectorAll: () => [secret], querySelector: () => null },
        HTMLInputElement: Input, HTMLFormElement: Form,
      });
      expect(secret.value).toBe("");
      return { result: { value: result } };
    }),
    detach: vi.fn(async () => {}),
  };
  const page = {
    viewport: () => ({ width: 800, height: 600 }),
    target: () => ({ createCDPSession: async () => ({
      send: async () => ({ targetInfo: { targetId: "original-tab" } }), detach: async () => {},
    }) }),
    url: () => address, setUrl: (next: string) => { address = next; },
    goto: vi.fn(async () => {}), setViewport: vi.fn(async () => {}),
    title: () => echoed || "Vendor login",
    evaluate: vi.fn(async (fn: () => unknown) => fn.toString().includes("getClientRects") ? true : echoed),
    screenshot: vi.fn(async () => "ZmFrZS1wbmc="),
    createCDPSession: vi.fn(async () => cdp),
    setBypassServiceWorker: vi.fn(async () => {}),
    setRequestInterception: vi.fn(async () => {}),
    on: vi.fn(),
    off: vi.fn(),
    waitForNavigation: async () => ({ ok: () => true }),
    mouse: { click: vi.fn(), move: vi.fn(), wheel: vi.fn() },
    keyboard: { press: vi.fn(), sendCharacter: vi.fn() },
  };
  const asTarget = (tab: typeof page) => ({ ...tab.target(), type: () => "page", page: vi.fn(async () => tab) });
  const original = asTarget(page);
  const browser = { pages: vi.fn(async () => [page]), targets: vi.fn(() => [original]), disconnect: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  acquire.mockImplementation(async () => ({ sessionId: "remote-browser-only" }));
  connect.mockResolvedValue(browser);
  return { browser, page, cdp, submit, original, asTarget };
}

describe("dashboard browser access", () => {
  it("uses the reconnected page viewport for frame metadata and input bounds", async () => {
    const f = fixture();
    const { page } = rendering();
    await f.command({ kind: "open", runId: owner, url: site });
    expect(await f.command({ kind: "frame", actor: owner })).toMatchObject(page.viewport());
    await f.command({ kind: "control", actor: owner, runId: owner, control: { action: "takeover" } });
    const click = (x: number) => f.command({ kind: "control", actor: owner, runId: owner,
      control: { action: "input", input: { kind: "click", x, y: 599 } } });
    await click(799);
    await expect(click(800)).rejects.toThrow(/outside the browser viewport/);
    expect(page.mouse.click).toHaveBeenCalledExactlyOnceWith(799, 599);
  });

  it("pins the original tab across reconnects and refuses a replacement when it closes", async () => {
    const f = fixture();
    const { page, browser, original, asTarget } = rendering();
    await f.command({ kind: "open", runId: owner, url: site });
    const replacement = { ...page, title: () => "Not the original tab", target: () => ({
      createCDPSession: async () => ({ send: async () => ({ targetInfo: { targetId: "different-tab" } }), detach: async () => {} }),
    }) };
    const different = asTarget(replacement);
    browser.pages.mockResolvedValue([replacement, page]);
    browser.targets.mockReturnValue([different, original]);
    expect(await f.command({ kind: "read" })).toMatchObject({ title: "Vendor login" });
    expect(different.page).not.toHaveBeenCalled();
    browser.pages.mockResolvedValue([replacement]);
    browser.targets.mockReturnValue([different]);
    expect(await f.command({ kind: "frame", actor: owner })).toEqual({ state: "closed" });
    expect(page.screenshot).not.toHaveBeenCalled();
  });
  it("requires human auth, scopes frame reads to the owner, and verifies a named thread before accessing its DO", async () => {
    const f = fixture();
    rendering();
    await f.command({ kind: "open", runId: owner, url: site });
    const path = "/api/sessions/browser";
    expect((await handleBrowserSession(request(path, { actor: "" }), f.env)).status).toBe(401);
    expect((await handleBrowserSession(request(path, { authorization: "Bearer example" }), f.env)).status).toBe(401);
    const host = await handleBrowserSession(request(path), f.env);
    expect(host.headers.get("cache-control")).toBe("no-store");
    expect(await host.json()).toMatchObject({ state: "live", image: "ZmFrZS1wbmc=", url: `${site}/` });
    expect(await (await handleBrowserSession(request(path, { actor: outsider }), f.env)).json()).toEqual({ state: "none" });
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const registry = vi.fn(async () => Response.json({
      session: { id: sessionId, userId: owner, agentName: buildSessionAgentName(owner, sessionId), name: "Browser thread", createdAt: 1, updatedAt: 1 },
    }));
    f.env.CodingOrchestrator = { idFromName: (id: string) => id, get: () => ({ fetch: registry, __unsafe_ensureInitialized: async () => {} }) } as never;
    expect((await handleBrowserSession(request(`${path}?session=${sessionId}`, { actor: outsider }), f.env)).status).toBe(404);
    expect(registry).toHaveBeenCalledOnce();
    expect((await handleBrowserSession(request(path, { method: "POST", origin: site, body: { action: "stop" } }), f.env)).status).toBe(403);
  });

  it("reconnects across requests, pauses every agent action, and records only take-over and hand-back", async () => {
    const f = fixture();
    const { browser, page } = rendering();
    await f.command({ kind: "open", runId: owner, url: site });
    expect(acquire.mock.calls[0]?.[1]).toMatchObject({ guardrails: { allowedDomains: ["accounts.example.test"] } });
    expect((await f.command({ kind: "control", actor: owner, runId: owner, control: { action: "takeover" } }))).toEqual({ state: "paused", controlling: true });
    await expect(f.command({ kind: "open", runId: owner, url: site })).rejects.toThrow(/paused: a person/);
    await expect(f.command({ kind: "read" })).rejects.toThrow(/paused: a person/);
    await expect(f.command({ kind: "close" })).rejects.toThrow(/paused: a person/);
    await expect(f.command({
      kind: "control", actor: outsider, runId: owner, control: { action: "input", input: { kind: "click", x: 123, y: 456 } },
    })).rejects.toThrow(/paused: a person/);
    await f.command({ kind: "control", actor: owner, runId: owner, control: { action: "input", input: { kind: "click", x: 123, y: 456 } } });
    expect(page.mouse.click).toHaveBeenCalledWith(123, 456);
    await f.command({ kind: "control", actor: owner, runId: owner, control: { action: "handback" } });
    expect(await f.command({ kind: "read" })).toMatchObject({ url: `${site}/` });
    expect(connect.mock.calls.every(([, id]) => id === "remote-browser-only")).toBe(true);
    expect(browser.disconnect).toHaveBeenCalled();
    const rows = f.db.prepare("SELECT tool FROM audit_log ORDER BY rowid").all().map((row) => row.tool);
    expect(rows).toEqual(["browser_takeover", "browser_handback"]);
    await f.command({ kind: "end" });
    expect(await f.command({ kind: "frame", actor: owner })).toEqual({ state: "closed" });
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("expires idle browsers even if a dashboard keeps polling", async () => {
    const f = fixture();
    const { browser } = rendering();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    await f.command({ kind: "open", runId: owner, url: site });
    clock.mockReturnValue(1_100_000);
    await f.command({ kind: "frame", actor: owner });
    clock.mockReturnValue(1_181_000);
    await new BrowserSession({ storage: f.storage } as never, f.env).alarm();
    expect(await f.command({ kind: "frame", actor: owner })).toEqual({ state: "closed" });
    expect(browser.close).toHaveBeenCalledOnce();
  });
});

describe("saved browser logins", () => {
  it.each([false, true])("executes only after an affirmative SDK approval response (approved=%s)", async (approved) => {
    const f = fixture();
    const { submit } = rendering();
    const loginId = await createLogin(f.env);
    await f.command({ kind: "open", runId: owner, url: site });
    const tools = createChatAgentMediaTools(f.env, { runId: owner, userId: owner, canUseBrowserLogins: async () => true });
    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    };
    const model = new MockLanguageModelV4({ doGenerate: [
      { usage, warnings: [], finishReason: { unified: "tool-calls", raw: undefined }, content: [
        { type: "tool-call", toolName: "browser_sign_in", toolCallId: "sdk-login", input: JSON.stringify({ loginId }) },
      ] },
      { usage, warnings: [], finishReason: { unified: "stop", raw: undefined }, content: [{ type: "text", text: "Done" }] },
    ] });
    const messages: ModelMessage[] = [{ role: "user", content: "Use the synthetic saved login." }];
    const pending = await generateText({ model, tools, messages });
    const approval = pending.content.find((part) => part.type === "tool-approval-request");
    if (!approval || approval.isAutomatic) throw new Error("Expected a manual approval.");
    expect(submit).not.toHaveBeenCalled();
    messages.push(...pending.responseMessages, {
      role: "tool", content: [{ type: "tool-approval-response", approvalId: approval.approvalId, approved }],
    });
    const result = await generateText({ model, tools, messages });
    expect(submit).toHaveBeenCalledTimes(approved ? 1 : 0);
    const visible = JSON.stringify([messages, result.responseMessages, model.doGenerateCalls]);
    expect(visible.includes(password) || visible.includes(fakeSeed)).toBe(false);
    if (approved) expect(visible).toContain("Vendor console");
  });
  it.each([
    ["DELETE", "frame"], ["PATCH", "frame"], ["DELETE", "input"], ["PATCH", "input"], ["invalid URL", "frame"],
  ] as const)("invalidates the live signed-in tab on %s before %s", async (reason, check) => {
    const f = fixture();
    const { page, browser } = rendering();
    const loginId = await createLogin(f.env);
    const args = { loginId, actor: owner, toolCallId: "revocable" };
    await f.command({ kind: "open", runId: owner, url: site });
    await f.command({ kind: "prepare-sign-in", ...args });
    expect(await f.command({ kind: "sign-in", ...args })).toMatchObject({ signedIn: true });
    if (check === "input") await f.command({ kind: "control", actor: owner, runId: owner, control: { action: "takeover" } });
    if (reason === "invalid URL") page.setUrl("about:blank");
    else {
      const update = await handleBrowserLogins(request(`/api/browser-logins/${loginId}`, {
        method: reason, ...(reason === "PATCH" ? { body: { label: "Rotated" } } : {}),
      }), f.env);
      expect(update.ok).toBe(true);
    }
    if (check === "input") {
      await expect(f.command({ kind: "control", actor: owner, runId: owner, control: {
        action: "input", input: { kind: "click", x: 10, y: 10 },
      } })).rejects.toThrow(/was closed/);
    } else {
      expect(await f.command({ kind: "frame", actor: owner })).toEqual({ state: "closed" });
    }
    expect(browser.close).toHaveBeenCalledOnce();
    expect(page.screenshot).not.toHaveBeenCalled();
    expect(page.mouse.click).not.toHaveBeenCalled();
  });
  it("scopes CRUD, keeps fields write-only, and enforces a canonical origin", async () => {
    const { env, db } = fixture();
    const id = await createLogin(env);
    const path = `/api/browser-logins/${id}`;
    const stored = db.prepare("SELECT * FROM browser_logins").get()!;
    expect(String(stored.password_ciphertext)).toMatch(/^v2\.legacy\.browser-login\./);
    expect(stored.totp_ciphertext).not.toEqual(stored.password_ciphertext);
    const results = [
      await handleBrowserLogins(request(path), env),
      await handleBrowserLogins(request("/api/browser-logins"), env),
      await handleBrowserLogins(request(path, { method: "PATCH", body: { label: "Updated login" } }), env),
    ];
    for (const result of results) {
      const output = await result.text();
      expect(output.includes(password) || output.includes(fakeSeed) || output.includes("ciphertext")).toBe(false);
    }
    expect((await handleBrowserLogins(request(path, { actor: outsider }), env)).status).toBe(404);
    expect((await handleBrowserLogins(request(path, { method: "PATCH", body: { origin: "https://login.example.test" } }), env)).status).toBe(409);
    expect((await handleBrowserLogins(request(path, { method: "PATCH", body: { origin: "https://*.example.test" } }), env)).status).toBe(400);
    expect((await handleBrowserLogins(request(path, { method: "DELETE" }), env)).status).toBe(200);
    expect((await handleBrowserLogins(request(path), env)).status).toBe(404);
  });

  it("allows workspace owners and admins but not members or outsiders to manage logins", async () => {
    const f = fixture();
    const { env, db } = f;
    const { workspaceId } = await createTeamWorkspace({ AGENT_AUDIT: env.AGENT_AUDIT! }, owner, { name: "Credential fixture" });
    const workspace = `/api/browser-logins?workspaceId=${workspaceId}`;
    const include = db.prepare(`INSERT INTO team_workspace_memberships
      (tenant_id, workspace_id, user_id, role, status, version, joined_at)
      SELECT tenant_id, workspace_id, ?, ?, 'active', 1, 1 FROM team_workspace_memberships WHERE workspace_id = ? AND user_id = ?`);
    include.run("member@example.test", "member", workspaceId, owner);
    include.run("admin@example.test", "admin", workspaceId, owner);
    const body = { label: "Team console", origin: site, username: owner, password };
    const created = await handleBrowserLogins(request(workspace, { method: "POST", body }), env);
    expect(created.status).toBe(201);
    const { login } = await created.json() as { login: { id: string } };
    expect((await handleBrowserLogins(request(workspace, { actor: "admin@example.test" }), env)).status).toBe(200);
    expect((await handleBrowserLogins(request(workspace, { actor: "member@example.test", method: "POST", body }), env)).status).toBe(403);
    expect((await handleBrowserLogins(request(workspace, { actor: outsider }), env)).status).toBe(404);
    expect(await (await handleBrowserLogins(request("/api/browser-logins"), env)).json()).toEqual({ logins: [] });
    const { submit } = rendering();
    await f.command({ kind: "open", runId: owner, url: site });
    await expect(f.command({ kind: "prepare-sign-in", actor: "member@example.test", loginId: login.id, toolCallId: "member" }))
      .rejects.toThrow(/unavailable in this scope/);
    await f.command({ kind: "prepare-sign-in", actor: "admin@example.test", loginId: login.id, toolCallId: "admin" });
    db.prepare("UPDATE team_workspace_memberships SET role = 'member' WHERE workspace_id = ? AND user_id = ?").run(workspaceId, "admin@example.test");
    await expect(f.command({ kind: "sign-in", actor: "admin@example.test", loginId: login.id, toolCallId: "admin" }))
      .rejects.toThrow(/unavailable in this scope/);
    expect(submit).not.toHaveBeenCalled();
  });

  it("invalidates an approval when the saved login is changed", async () => {
    const f = fixture();
    const loginId = await createLogin(f.env);
    const { submit } = rendering();
    const opts = { loginId, actor: owner, toolCallId: "rev-bound-approval" };
    await f.command({ kind: "open", runId: owner, url: site });
    await f.command({ kind: "prepare-sign-in", ...opts });
    expect((await handleBrowserLogins(request(`/api/browser-logins/${loginId}`, {
      method: "PATCH", body: { username: "another operator" },
    }), f.env)).ok).toBe(true);
    await expect(f.command({ kind: "sign-in", ...opts })).rejects.toThrow(/changed after approval/);
    expect(submit).not.toHaveBeenCalled();
  });

  it("requires the SDK approval path and checks the page origin before and after approval", async () => {
    const f = fixture();
    const loginId = await createLogin(f.env);
    const { page } = rendering();
    const tools = createChatAgentMediaTools(f.env, {
      runId: owner, userId: owner, canUseBrowserLogins: async () => true,
    });
    const signIn = tools.browser_sign_in!;
    const options = { toolCallId: "tool-request", messages: [], context: undefined };
    const approval = signIn.needsApproval as (input: { loginId: string }, options: unknown) => Promise<boolean>;
    await f.command({ kind: "open", runId: owner, url: site });
    await expect(signIn.execute?.({ loginId }, options)).rejects.toThrow(/fresh human approval/);
    page.setUrl("https://accounts.example.test:444");
    await expect(approval({ loginId }, options)).rejects.toThrow(/does not match/);
    page.setUrl(site);
    expect(await approval({ loginId }, options)).toBe(true);
    page.setUrl("https://sub.accounts.example.test");
    await expect(signIn.execute?.({ loginId }, options)).rejects.toThrow(/does not match/);
    expect(page.createCDPSession).not.toHaveBeenCalled();
  });

  it("fills the fake isolated form, redacts credentials from outputs, and won't replay approval", async () => {
    const f = fixture();
    const loginId = await createLogin(f.env);
    const { submit, page } = rendering();
    const clock = vi.spyOn(Date, "now").mockReturnValue(59_000);
    const opts = { loginId, actor: owner, toolCallId: "approval-1" };
    expect(await browserLoginCode(fakeSeed, clock())).toBe("287082");
    await f.command({ kind: "open", runId: owner, url: site });
    await f.command({ kind: "prepare-sign-in", ...opts });
    const result = await f.command({ kind: "sign-in", ...opts });
    expect(result).toEqual({ signedIn: true, url: site, loginLabel: "Vendor console" });
    expect(submit.mock.calls[0]?.[0]?.[0]).toBe("operator");
    expect(submit.mock.calls[0]?.[0]?.[1] === password).toBe(true);
    expect(submit.mock.calls[0]?.[0]?.[2]).toBe("287082");
    const sameOrigin = { isInterceptResolutionHandled: () => false, url: () => `${site}/session`, continue: vi.fn(async () => {}), abort: vi.fn(async () => {}) };
    const otherOrigin = { ...sameOrigin, url: () => "https://accounts.example.test:444/session" };
    const handle = page.on.mock.calls[0]?.[1];
    handle(sameOrigin);
    handle(otherOrigin);
    expect(sameOrigin.continue).toHaveBeenCalledOnce();
    expect(otherOrigin.abort).toHaveBeenCalledOnce();
    const read = await f.command({ kind: "read" });
    expect(read).toMatchObject({ text: "Fake echo: [redacted] [redacted] [redacted]" });
    const retained = JSON.stringify([result, read, [...f.table.values()], f.db.prepare("SELECT * FROM audit_log").all()]);
    expect(retained.includes(password) || retained.includes(fakeSeed) || retained.includes("287082")).toBe(false);
    await expect(f.command({ kind: "screenshot", runId: owner })).rejects.toThrow(/disabled after saved sign-in/);
    expect(page.screenshot).not.toHaveBeenCalled();
    await expect(f.command({ kind: "sign-in", ...opts })).rejects.toThrow(/fresh human approval/);
    await f.command({ kind: "open", runId: owner, url: site });
    await expect(f.command({ kind: "prepare-sign-in", ...opts })).rejects.toThrow(/no longer applies/);
  });

  it("doesn't forward a Browser Rendering error containing a synthetic password, and refuses MCP self-approval", async () => {
    const f = fixture();
    const loginId = await createLogin(f.env);
    const { cdp } = rendering();
    const opts = { loginId, actor: owner, toolCallId: "approval-2" };
    await f.command({ kind: "open", runId: owner, url: site });
    await f.command({ kind: "prepare-sign-in", ...opts });
    cdp.send.mockRejectedValue(new Error(password));
    const result = await f.command({ kind: "sign-in", ...opts });
    expect(result).toEqual({ signedIn: false, url: site, loginLabel: "Vendor console" });
    expect(JSON.stringify(result).includes(password)).toBe(false);
    expect(await f.command({ kind: "frame", actor: owner })).toEqual({ state: "closed" });
    const handlers = new Map();
    registerAgentMediaMcpTools({ registerTool: (name: string, _scope: string, handler: unknown) => handlers.set(name, handler) } as never, f.env);
    const denied = await handlers.get("browser_sign_in")({ loginId, approved: true });
    expect(denied).toMatchObject({ isError: true, structuredContent: { status: "approval_required" } });
  });
});
