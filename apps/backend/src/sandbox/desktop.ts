/**
 * Optional in-sandbox desktop layer (Xvfb + noVNC). Started on demand when
 * SHIBA_SANDBOX_DESKTOP=1; providers without the desktop capability refuse
 * early via {@link providerSupports}.
 */
import {
  CLOUDFLARE_SANDBOX_CAPABILITIES,
  providerSupports,
  SANDBOX_DESKTOP_PORT,
  SANDBOX_VNC_PASSWORD_ENV,
} from "@shiba/sandbox";
import type { Env } from "../env.js";
import { shellQuote } from "../security.js";

export { CLOUDFLARE_SANDBOX_CAPABILITIES, providerSupports, SANDBOX_DESKTOP_PORT };

export function isSandboxDesktopEnabled(env: Env): boolean {
  return env.SHIBA_SANDBOX_DESKTOP === "1" && providerSupports(CLOUDFLARE_SANDBOX_CAPABILITIES, "desktop");
}

export function randomVncPassword(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return b64url(bytes);
}

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

export interface DesktopExposeResult {
  /** Tokenized preview URL — bearer credential, never returned to browsers directly. */
  httpOrigin: string;
  /** WebSocket entry for noVNC (wss when http is https). */
  wsUrl: string;
}

export function previewUrlsFromExpose(httpUrl: string): DesktopExposeResult {
  const parsed = new URL(httpUrl);
  const wsProto = parsed.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${wsProto}//${parsed.host}/`;
  return { httpOrigin: parsed.origin, wsUrl };
}

/**
 * Idempotent desktop bootstrap inside the container. Failures are surfaced to
 * the caller — they never fail the coding run unless desktop was required.
 */
async function sandboxFor(env: Env, sandboxId: string) {
  const { getSandbox } = await import("@cloudflare/sandbox");
  return getSandbox(env.Sandbox, sandboxId);
}

export async function startDesktopStack(
  env: Env,
  sandboxId: string,
  vncPassword: string,
): Promise<void> {
  const sandbox = await sandboxFor(env, sandboxId);
  const cmd = `${SANDBOX_VNC_PASSWORD_ENV}=${shellQuote(vncPassword)} shiba-desktop-start`;
  const boot = await sandbox.exec(cmd, { timeout: 90_000 });
  if (boot.exitCode !== 0) {
    throw new Error(`shiba-desktop-start failed: ${(boot.stderr ?? boot.stdout ?? "").slice(0, 500)}`);
  }
  const wait = await sandbox.exec(
    'sh -c \'for i in $(seq 1 60); do curl -sf "http://127.0.0.1:6080/" >/dev/null 2>&1 && exit 0; sleep 0.5; done; exit 1\'',
    { timeout: 45_000 },
  );
  if (wait.exitCode !== 0) {
    throw new Error("Desktop stack did not become reachable on port 6080.");
  }
}

export async function exposeDesktopPort(env: Env, sandboxId: string): Promise<DesktopExposeResult> {
  const host = env.WORKER_HOSTNAME?.trim();
  if (!host) {
    throw new Error("WORKER_HOSTNAME is required to expose the desktop port.");
  }
  const sandbox = await sandboxFor(env, sandboxId);
  const exposed = await sandbox.exposePort(SANDBOX_DESKTOP_PORT, { hostname: host });
  return previewUrlsFromExpose(exposed.url);
}

export async function unexposeDesktopPort(env: Env, sandboxId: string): Promise<void> {
  const sandbox = await sandboxFor(env, sandboxId);
  await sandbox.unexposePort(SANDBOX_DESKTOP_PORT).catch(() => undefined);
}
