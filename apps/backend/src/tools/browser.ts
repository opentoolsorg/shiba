import type { Env } from "../env.js";
import { redactSecrets } from "../security.js";
import { assertPublicBrowserUrl, selectorRequiresSubmitApproval } from "./browser-url.js";
import { closeBrowserSession, getBrowserSession, setBrowserSession, type BrowserSession } from "./browser-sessions.js";
import type { PreviewPuppeteerBrowser } from "../preview/types.js";

async function launchBrowser(env: Pick<Env, "BROWSER">): Promise<PreviewPuppeteerBrowser> {
  if (!env.BROWSER) throw new Error("Browser rendering is not configured.");
  const puppeteer = await import("@cloudflare/puppeteer");
  return puppeteer.default.launch(env.BROWSER) as unknown as Promise<PreviewPuppeteerBrowser>;
}

export async function browserOpen(env: Pick<Env, "BROWSER">, runId: string, url: string): Promise<{ sessionId: string; url: string; title: string }> {
  const target = assertPublicBrowserUrl(url);
  await closeBrowserSession(runId);
  const browser = await launchBrowser(env);
  const page = await browser.newPage();
  await page.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
  const title = await page.evaluate(() => document.title);
  const session: BrowserSession = { sessionId: runId, runId, page, browser, createdAt: Date.now(), currentUrl: target.toString() };
  setBrowserSession(session);
  return { sessionId: runId, url: target.toString(), title };
}

export async function browserRead(runId: string): Promise<{ text: string; title: string; url: string | null }> {
  const session = getBrowserSession(runId);
  if (!session) throw new Error("Open a browser session with browser_open first.");
  const text = await session.page.evaluate(() => {
    const article = document.querySelector("article");
    const main = document.querySelector("main");
    const body = article?.textContent ?? main?.textContent ?? document.body?.textContent ?? "";
    return body.replace(/\s+/g, " ").trim().slice(0, 12000);
  });
  const title = await session.page.evaluate(() => document.title);
  const url = session.currentUrl ?? await session.page.evaluate(() => globalThis.location.href);
  session.currentUrl = url;
  return { text, title, url };
}

export async function browserClick(runId: string, selector: string, options?: { approved?: boolean }): Promise<{ clicked: boolean; selector: string }> {
  const session = getBrowserSession(runId);
  if (!session) throw new Error("Open a browser session with browser_open first.");
  if (!options?.approved && selectorRequiresSubmitApproval(selector)) {
    throw new Error("browser_click requires human approval for submit-like selectors.");
  }
  await session.page.click(selector, { timeout: 15_000 });
  session.currentUrl = await session.page.evaluate(() => globalThis.location.href);
  return { clicked: true, selector };
}

export async function browserType(runId: string, selector: string, text: string, options?: { approved?: boolean }): Promise<{ typed: boolean; selector: string }> {
  const session = getBrowserSession(runId);
  if (!session) throw new Error("Open a browser session with browser_open first.");
  if (!options?.approved && selectorRequiresSubmitApproval(selector, text)) {
    throw new Error("browser_type requires human approval for password or submit fields.");
  }
  await session.page.click(selector, { timeout: 15_000 });
  await session.page.type(selector, text, { delay: 10 });
  return { typed: true, selector };
}

export async function browserScreenshot(
  env: Pick<Env, "ARTIFACTS" | "FILES" | "WORKER_HOSTNAME">,
  runId: string,
): Promise<{ key: string; url: string | null; bytes: number }> {
  const session = getBrowserSession(runId);
  if (!session) throw new Error("Open a browser session with browser_open first.");
  const bucket = env.FILES ?? env.ARTIFACTS;
  if (!bucket) throw new Error("Output storage is not configured.");
  const png = await session.page.screenshot({ fullPage: false });
  const key = `outputs/${encodeURIComponent(runId)}/browser-${Date.now()}.png`;
  await bucket.put(key, png, {
    httpMetadata: { contentType: "image/png" },
    customMetadata: { kind: "output", runId },
  });
  return { key, url: null, bytes: png.byteLength };
}

export function browserToolError(error: unknown): { isError: true; message: string } {
  return { isError: true, message: redactSecrets(error instanceof Error ? error.message : String(error)) };
}