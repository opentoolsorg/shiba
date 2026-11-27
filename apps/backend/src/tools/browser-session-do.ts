import { DurableObject } from "cloudflare:workers";
import type { Browser, Page, Target } from "@cloudflare/puppeteer";
import type { Env } from "../env.js";
import { audit } from "../audit.js";
import { getTeamWorkspaceMembership } from "../team-workspaces-store.js";
import { browserLoginIntent, browserLoginWorkspace, decryptBrowserLogin, type BrowserLoginScope } from "./browser-logins.js";
import { browserLoginCode, redactBrowserLoginOutput, submitBrowserLogin } from "./browser-sign-in.js";
import { assertPublicBrowserUrl } from "./browser-url.js";
import type { BrowserCommand } from "./browser-sessions.js";

const IDLE_MS = 3 * 60_000;
const APPROVAL_MS = 2 * 60_000;
const PAUSED = "Browser paused: a person is controlling the browser.";

type SignInApproval = {
  toolCallId: string;
  actor: string;
  scope: BrowserLoginScope;
  login: NonNullable<Awaited<ReturnType<typeof browserLoginIntent>>>;
  at: number;
};

type Session = {
  remoteId: string;
  targetId?: string;
  expiresAt: number;
  controller?: string;
  approval?: SignInApproval;
  signedIn?: SignInApproval & { usedAt: number };
};

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

class BrowserCommandError extends Error {}

function pageUrl(page: Page): URL {
  return assertPublicBrowserUrl(page.url());
}

async function browserTargetId(target: Target): Promise<string> {
  const client = await target.createCDPSession();
  try {
    return (await client.send("Target.getTargetInfo")).targetInfo.targetId;
  } finally {
    await client.detach().catch(() => undefined);
  }
}

function displayUrl(page: Page, session: Session): string {
  const url = pageUrl(page);
  return session.signedIn ? url.origin : `${url.origin}${url.pathname}`;
}

export class BrowserSession extends DurableObject<Env> {
  private pending: Promise<unknown> = Promise.resolve();

  private serial<T>(execute: () => Promise<T>): Promise<T> {
    const result = this.pending.then(execute);
    this.pending = result.catch(() => undefined);
    return result;
  }

  fetch(request: Request): Promise<Response> {
    return this.serial(async () => {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/command") return json({ error: "Not found." }, 404);
      try {
        return await this.execute(await request.json<BrowserCommand>());
      } catch (error) {
        return json({
          error: error instanceof BrowserCommandError ? error.message : "Browser action failed. Try opening the page again.",
        }, 409);
      }
    });
  }

  alarm(): Promise<void> {
    return this.serial(async () => {
      const session = await this.ctx.storage.get<Session>("session");
      if (!session) return;
      if (session.expiresAt > Date.now()) await this.ctx.storage.setAlarm(session.expiresAt);
      else await this.close(session);
    });
  }

  private async connectBrowser(remoteId: string): Promise<Browser> {
    if (!this.env.BROWSER) throw new BrowserCommandError("Browser Rendering is not configured.");
    const { default: puppeteer } = await import("@cloudflare/puppeteer");
    return puppeteer.connect(this.env.BROWSER, remoteId);
  }

  private async save(session: Session, expiresAt = session.expiresAt) {
    if (expiresAt !== session.expiresAt) await this.ctx.storage.setAlarm(expiresAt);
    await this.ctx.storage.put("session", { ...session, expiresAt });
  }

  private async close(session: Session, browser?: Browser) {
    await this.ctx.storage.put("closed", true);
    await this.ctx.storage.delete("session");
    try {
      const connection = browser ?? await this.connectBrowser(session.remoteId);
      await connection.close().catch(() => connection.disconnect().catch(() => undefined));
    } catch {
      // Browser Rendering independently expires disconnected sessions.
    }
  }

  private async receipt(actor: string, runId: string, event: string) {
    if (!this.env.AGENT_AUDIT) return;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([runId, event])));
    await audit({ AGENT_AUDIT: this.env.AGENT_AUDIT }, {
      principal: actor, tool: event, outcome: "ok", detail: `thread:${runId}`,
      argsHash: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    });
  }

  private state(session: Session, actor: string) {
    return session.controller
      ? { state: "paused", controlling: session.controller === actor }
      : { state: "live" };
  }

  private async open(command: Extract<BrowserCommand, { kind: "open" }>, existing?: Session) {
    if (!this.env.BROWSER) throw new BrowserCommandError("Browser Rendering is not configured.");
    let target: URL;
    try { target = assertPublicBrowserUrl(command.url); }
    catch { throw new BrowserCommandError("Enter a public HTTP or HTTPS URL."); }
    if (existing) await this.close(existing);

    const { default: puppeteer } = await import("@cloudflare/puppeteer");
    const expiresAt = Date.now() + IDLE_MS;
    const { sessionId: remoteId } = await puppeteer.acquire(this.env.BROWSER, {
      keep_alive: IDLE_MS + 30_000,
      guardrails: { allowedDomains: [target.hostname] },
    });
    const session: Session = { remoteId, expiresAt };
    let browser: Browser | undefined;
    try {
      await this.ctx.storage.setAlarm(expiresAt);
      await this.save(session);
      browser = await this.connectBrowser(remoteId);
      const page = (await browser.pages())[0] ?? await browser.newPage();
      await this.save({ ...session, targetId: await browserTargetId(page.target()) });
      await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 20_000 });
      return json({ sessionId: command.runId, url: displayUrl(page, session), title: await page.title() });
    } catch (error) {
      await this.close(session, browser);
      throw error;
    } finally {
      await browser?.disconnect().catch(() => undefined);
    }
  }

  private async browserPage(session: Session, command: BrowserCommand): Promise<Response> {
    let browser: Browser;
    try { browser = await this.connectBrowser(session.remoteId); }
    catch {
      if (command.kind === "frame" && this.env.BROWSER) {
        const { default: puppeteer } = await import("@cloudflare/puppeteer");
        const active = await puppeteer.sessions(this.env.BROWSER).catch(() => null);
        if (active && !active.some((browser) => browser.sessionId === session.remoteId)) {
          await this.close(session);
          return json({ state: "closed" });
        }
        return json(this.state(session, command.actor));
      }
      throw new BrowserCommandError("Could not reconnect to the browser. Try again or open a new page.");
    }
    try {
      let page: Page | undefined;
      for (const target of session.targetId ? browser.targets() : []) {
        if (target.type() === "page" && await browserTargetId(target).catch(() => undefined) === session.targetId) {
          page = await target.page().catch(() => null) ?? undefined;
          break;
        }
      }
      if (!page) {
        await this.close(session, browser);
        if (command.kind === "frame") return json({ state: "closed" });
        throw new BrowserCommandError("The browser tab was closed.");
      }
      if (session.signedIn) {
        const { login, scope } = session.signedIn;
        const current = await browserLoginIntent(this.env, scope, login.id);
        let origin: string | undefined;
        try { origin = pageUrl(page).origin; } catch {}
        if (current?.revision !== login.revision || current.origin !== login.origin ||
            origin !== login.origin || !await this.canUseLogin(session.signedIn)) {
          await this.close(session, browser);
          if (command.kind === "frame") return json({ state: "closed" });
          throw new BrowserCommandError("The signed-in browser no longer matches its login, origin or permissions and was closed.");
        }
      }
      switch (command.kind) {
        case "frame": {
          const viewport = page.viewport();
          if (!viewport) throw new BrowserCommandError("The current browser viewport is unavailable.");
          const image = await page.screenshot({ encoding: "base64", type: "png" });
          return json({ ...this.state(session, command.actor), url: displayUrl(page, session), image, width: viewport.width, height: viewport.height });
        }
        case "read": {
          const secrets = session.signedIn ? await this.activeSecrets(session.signedIn) : [];
          const text = await page.evaluate(() =>
            ((document.querySelector("article") ?? document.querySelector("main") ?? document.body)?.textContent ?? "").slice(0, 24_000));
          const title = await page.title();
          return json({
            text: redactBrowserLoginOutput(text, secrets).replace(/\s+/g, " ").trim().slice(0, 12_000),
            title: redactBrowserLoginOutput(title, secrets),
            url: displayUrl(page, session),
          });
        }
        case "click":
          await page.click(command.selector);
          return json({ clicked: true, selector: command.selector });
        case "type":
          await page.type(command.selector, command.text);
          return json({ typed: true, selector: command.selector });
        case "screenshot": {
          if (session.signedIn) throw new BrowserCommandError("Agent screenshots are disabled after saved sign-in. Use the private Browser panel.");
          const bucket = this.env.FILES ?? this.env.ARTIFACTS;
          if (!bucket) throw new BrowserCommandError("Output storage is not configured.");
          const png = await page.screenshot({ type: "png" });
          const key = `outputs/${encodeURIComponent(command.runId)}/browser-${Date.now()}.png`;
          await bucket.put(key, png, { httpMetadata: { contentType: "image/png" }, customMetadata: { kind: "output", runId: command.runId } });
          return json({ key, url: null, bytes: png.byteLength });
        }
        case "control": {
          if (command.control.action !== "input") break;
          const input = command.control.input;
          if (input.kind === "click" || input.kind === "scroll") {
            const viewport = page.viewport();
            if (!viewport || input.x >= viewport.width || input.y >= viewport.height) throw new BrowserCommandError("Input is outside the browser viewport.");
            if (input.kind === "click") await page.mouse.click(input.x, input.y);
            else {
              await page.mouse.move(input.x, input.y);
              await page.mouse.wheel({ deltaX: input.deltaX, deltaY: input.deltaY });
            }
          } else if (input.kind === "text") await page.keyboard.sendCharacter(input.text);
          else await page.keyboard.press(input.key);
          return json(this.state(session, command.actor));
        }
        case "prepare-sign-in": {
          if (session.signedIn) throw new BrowserCommandError("Open a new browser before using another saved login.");
          const workspace = this.env.AGENT_AUDIT ? await browserLoginWorkspace(this.env.AGENT_AUDIT, command.loginId) : null;
          const scope: BrowserLoginScope = workspace ? { kind: "workspace", id: workspace } : { kind: "personal", id: command.actor };
          const access = { actor: command.actor, scope };
          if (!await this.canUseLogin(access)) throw new BrowserCommandError("Saved login is unavailable in this scope.");
          const login = await browserLoginIntent(this.env, scope, command.loginId);
          if (!login) throw new BrowserCommandError("Saved login is unavailable in this scope.");
          if (pageUrl(page).origin !== login.origin) throw new BrowserCommandError("Saved login does not match the current page origin.");
          if (session.approval?.toolCallId !== command.toolCallId) {
            const attempts = ((await this.ctx.storage.get<Array<{ id: string; at: number }>>("sign-in-attempts")) ?? [])
              .filter((attempt) => attempt.at > Date.now() - 24 * 60 * 60_000);
            if (attempts.some((attempt) => attempt.id === command.toolCallId)) {
              throw new BrowserCommandError("This approval no longer applies. Ask for a new saved sign-in.");
            }
            if (attempts.length >= 64) throw new BrowserCommandError("Too many saved sign-in requests in this thread.");
            await this.ctx.storage.put("sign-in-attempts", [...attempts, { id: command.toolCallId, at: Date.now() }]);
            await this.save({ ...session, approval: { ...access, login, toolCallId: command.toolCallId, at: Date.now() } });
          }
          return json({ pending: true });
        }
        case "sign-in": {
          const approval = session.approval;
          if (!approval || approval.toolCallId !== command.toolCallId || approval.actor !== command.actor ||
              approval.login.id !== command.loginId || Date.now() - approval.at > APPROVAL_MS) {
            throw new BrowserCommandError("Saved sign-in requires a fresh human approval for this browser session.");
          }
          if (!await this.canUseLogin(approval)) throw new BrowserCommandError("Saved login is unavailable in this scope.");
          if (pageUrl(page).origin !== approval.login.origin) throw new BrowserCommandError("Saved login does not match the current page origin.");
          const credentials = this.env.AGENT_AUDIT && await decryptBrowserLogin(
            { ...this.env, AGENT_AUDIT: this.env.AGENT_AUDIT }, approval.scope, approval.login,
          );
          if (!credentials) throw new BrowserCommandError("Saved login changed after approval. Request a new approval.");
          const usedAt = Date.now();
          const { origin } = approval.login;
          await this.save({ ...session, approval: undefined, signedIn: { ...approval, usedAt } });
          let signedIn = false;
          let code: string | null = null;
          try {
            code = credentials.totpSecret ? await browserLoginCode(credentials.totpSecret, usedAt) : null;
            signedIn = await submitBrowserLogin(page, { origin, username: credentials.username, password: credentials.password, code });
          } catch {
            // Never return browser/CDP errors from a request that carries plaintext.
          }
          if (!signedIn) await this.close(session, browser);
          return json({ signedIn, url: origin, loginLabel: redactBrowserLoginOutput(credentials.label, [credentials.password, credentials.totpSecret, code]) });
        }
      }
      throw new BrowserCommandError("Unsupported browser command.");
    } finally {
      await browser.disconnect().catch(() => undefined);
    }
  }

  private async canUseLogin({ actor, scope }: Pick<SignInApproval, "actor" | "scope">) {
    if (scope.kind === "personal") return scope.id === actor;
    const membership = this.env.AGENT_AUDIT && await getTeamWorkspaceMembership({ AGENT_AUDIT: this.env.AGENT_AUDIT }, scope.id, actor);
    return membership?.role === "owner" || membership?.role === "admin";
  }

  private async activeSecrets(used: NonNullable<Session["signedIn"]>) {
    const credentials = this.env.AGENT_AUDIT && await this.canUseLogin(used) && await decryptBrowserLogin(
      { ...this.env, AGENT_AUDIT: this.env.AGENT_AUDIT }, used.scope, used.login,
    );
    if (!credentials) throw new BrowserCommandError("Saved login is no longer available. Open a new browser to continue.");
    const code = credentials.totpSecret ? await browserLoginCode(credentials.totpSecret, used.usedAt) : null;
    return [credentials.password, credentials.totpSecret, code];
  }

  private async execute(command: BrowserCommand): Promise<Response> {
    let session = await this.ctx.storage.get<Session>("session");
    if (session && session.expiresAt <= Date.now()) {
      await this.close(session);
      session = undefined;
    }
    const human = command.kind === "control" || command.kind === "frame";
    if (session?.controller && !human && command.kind !== "end") throw new BrowserCommandError(PAUSED);
    if (command.kind === "open") return this.open(command, session);
    if (!session) {
      if (command.kind === "frame") return json({ state: await this.ctx.storage.get("closed") ? "closed" : "none" });
      if (command.kind === "end" || command.kind === "close") return json({ closed: true });
      if (command.kind === "control" && command.control.action === "stop") return json({ state: "closed" });
      throw new BrowserCommandError("Open a browser session with browser_open first.");
    }
    if (command.kind === "close" || command.kind === "end" || (command.kind === "control" && command.control.action === "stop")) {
      await this.close(session);
      return json({ closed: true, state: "closed" });
    }
    if (command.kind === "control") {
      if (session.controller && session.controller !== command.actor) throw new BrowserCommandError(PAUSED);
      if (command.control.action === "takeover" || command.control.action === "handback") {
        const controller = command.control.action === "takeover" ? command.actor : undefined;
        if (controller !== session.controller) {
          session = { ...session, controller, approval: undefined };
          await this.save(session, Date.now() + IDLE_MS);
          await this.receipt(command.actor, command.runId, controller ? "browser_takeover" : "browser_handback");
        }
        return json(this.state(session, command.actor));
      }
      if (session.controller !== command.actor) throw new BrowserCommandError("Take over the browser before sending input.");
    }
    if (command.kind !== "frame") {
      const expiresAt = Date.now() + IDLE_MS;
      await this.save(session, expiresAt);
      session = { ...session, expiresAt };
    }
    return this.browserPage(session, command);
  }
}
