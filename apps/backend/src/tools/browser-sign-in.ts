import type { HTTPRequest, Page } from "@cloudflare/puppeteer";
import { redactSecrets } from "../security.js";

export async function browserLoginCode(secret: string, now: number): Promise<string> {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bytes: number[] = [];
  let bits = 0, value = 0;
  for (const char of secret) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 255);
    }
  }
  const counter = new ArrayBuffer(8);
  new DataView(counter).setBigUint64(0, BigInt(Math.floor(now / 30_000)));
  const key = await crypto.subtle.importKey("raw", Uint8Array.from(bytes), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = new DataView(await crypto.subtle.sign("HMAC", key, counter));
  const offset = mac.getUint8(mac.byteLength - 1) & 15;
  return String((mac.getUint32(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

interface SignInFields {
  origin: string;
  username: string;
  password: string;
  code: string | null;
}

function submitSameOriginForm({ origin, username, password, code }: SignInFields): boolean {
  if (location.origin !== origin) return false;
  const ready = (input: HTMLInputElement) => Boolean(input.name && !input.matches(":disabled") &&
    !input.readOnly && input.getClientRects().length && getComputedStyle(input).visibility === "visible");
  const passwords = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="password"]')).filter(ready);
  const field = passwords[0], form = field?.form;
  if (passwords.length !== 1 || !field || !form || field.autocomplete.includes("new-password")) return false;
  const action = new URL(form.getAttribute("action") || location.href, document.baseURI);
  const target = form.getAttribute("target") || document.querySelector("base[target]")?.getAttribute("target");
  if (action.origin !== origin || action.username || action.password || form.method.toLowerCase() !== "post" ||
      (target && target.toLowerCase() !== "_self") || form.matches('[enctype="text/plain"]')) return false;
  const inputs = Array.from(form.elements).filter((el): el is HTMLInputElement => el instanceof HTMLInputElement && ready(el));
  const loginFields = inputs.filter((input) => input.autocomplete.split(" ").includes("username"));
  const fallback = inputs.filter((input) => input.type === "email" ||
    (input.type === "text" && /^(email|username|user|login)$/i.test(input.name)));
  const users = loginFields.length ? loginFields : fallback;
  if (users.length !== 1 || !users[0] || users[0] === field) return false;
  const codes = code ? inputs.filter((input) => input.autocomplete.split(" ").includes("one-time-code")) : [];
  if (codes.length > 1 || codes[0] === field || codes[0] === users[0]) return false;
  users[0].value = username;
  field.value = password;
  if (code && codes[0]) codes[0].value = code;
  try {
    HTMLFormElement.prototype.submit.call(form);
  } finally {
    field.value = "";
    if (codes[0]) codes[0].value = "";
  }
  return true;
}

export async function submitBrowserLogin(page: Pick<Page, "url" | "createCDPSession" | "waitForNavigation" | "evaluate" |
  "setBypassServiceWorker" | "setRequestInterception" | "on" | "off">, fields: SignInFields): Promise<boolean> {
  if (new URL(page.url()).origin !== fields.origin) return false;
  const client = await page.createCDPSession();
  const allowOrigin = (request: HTTPRequest) => {
    if (request.isInterceptResolutionHandled()) return;
    const allowed = URL.canParse(request.url()) && new URL(request.url()).origin === fields.origin;
    (allowed ? request.continue() : request.abort()).catch(() => undefined);
  };
  try {
    await page.setBypassServiceWorker(true);
    page.on("request", allowOrigin);
    await page.setRequestInterception(true);
    const { frameTree } = await client.send("Page.getFrameTree");
    const { executionContextId } = await client.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id });
    const navigation = page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 12_000 }).catch(() => null);
    const submitted = await client.send("Runtime.callFunctionOn", {
      executionContextId,
      functionDeclaration: submitSameOriginForm.toString(),
      arguments: [{ value: fields }],
      returnByValue: true,
    });
    if (submitted.result.value !== true || submitted.exceptionDetails) return false;
    const response = await navigation;
    return Boolean(response?.ok() && new URL(page.url()).origin === fields.origin &&
      await page.evaluate(() => !Array.from(document.querySelectorAll('input[type="password"]')).some((field) => field.getClientRects().length)));
  } finally {
    try {
      await page.setRequestInterception(false);
    } finally {
      page.off("request", allowOrigin);
      await client.detach().catch(() => undefined);
    }
  }
}

export function redactBrowserLoginOutput(text: string, values: (string | null)[]): string {
  for (const value of values) {
    if (value) text = text.replaceAll(value, "[redacted]").replaceAll(encodeURIComponent(value), "[redacted]");
  }
  return redactSecrets(text);
}
