import { getSandboxInstance } from "../sandbox/provider.js";
import { instanceToPreviewSandbox } from "../sandbox/preview-bridge.js";
import puppeteer from "@cloudflare/puppeteer";
import type { Env } from "../env.js";
import { isValidSandboxId } from "../sandbox-routes.js";
import { createSandboxPortGateway, type SandboxPortForwardSource } from "./port-gateway.js";
import { allowSameOriginOnly } from "./request-policy.js";
import {
  NAV_TIMEOUT_MS,
  PORT_READY_TIMEOUT_MS,
  PREVIEW_PORT,
  type PreviewBrowserDeps,
  type PreviewPuppeteerBrowser,
  type PreviewPuppeteerPage,
  type PreviewSandbox,
} from "./types.js";

export interface StaticPreviewContext {
  previewUrl: string;
  page: PreviewPuppeteerPage;
  sandbox: PreviewSandbox;
  sandboxId: string;
  workdir: string;
}

import type { SandboxSelectionContext } from "../sandbox/selection.js";

export interface StaticPreviewDeps extends PreviewBrowserDeps {
  sandbox?: PreviewSandbox;
  selection?: SandboxSelectionContext;
}

/**
 * Serve the workdir on PREVIEW_PORT, expose it once, and run a Browser
 * Rendering callback with same-origin interception enabled.
 */
export async function withStaticPreview<T>(
  env: Env,
  input: { sandboxId: string; workdir?: string },
  run: (ctx: StaticPreviewContext) => Promise<T>,
  deps: StaticPreviewDeps = {},
): Promise<T | null> {
  if (!env.BROWSER) return null;
  const hostname = env.WORKER_HOSTNAME?.trim();
  if (!hostname || !isValidSandboxId(input.sandboxId)) return null;

  const raw =
    deps.sandbox ??
    instanceToPreviewSandbox(await getSandboxInstance(env, input.sandboxId, deps.selection ?? {}));
  const portSource = raw as PreviewSandbox & SandboxPortForwardSource;
  const portGateway =
    typeof raw.expose === "function" ? raw : createSandboxPortGateway(portSource);
  const sandbox: PreviewSandbox =
    typeof raw.expose === "function"
      ? raw
      : {
          exec: (command, options) => raw.exec(command, options),
          startProcess: (command, options) => raw.startProcess(command, options),
          expose: (port, options) => portGateway.expose(port, options),
          unexpose: (port) => portGateway.unexpose(port),
        };
  const workdir = input.workdir ?? `/workspace/${input.sandboxId}`;

  const proc = await sandbox.startProcess(`python3 -m http.server ${PREVIEW_PORT} --bind 0.0.0.0`, {
    cwd: workdir,
  });
  let previewUrl: string;
  const launch =
    deps.launch ?? ((b: Fetcher) => puppeteer.launch(b) as unknown as Promise<PreviewPuppeteerBrowser>);
  const browser = await launch(env.BROWSER);
  try {
    await proc.waitForPort(PREVIEW_PORT, { timeout: PORT_READY_TIMEOUT_MS });
    previewUrl = (await sandbox.expose(PREVIEW_PORT, { hostname })).url;
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      allowSameOriginOnly(request, previewUrl).catch(() => undefined);
    });
    return await run({ previewUrl, page, sandbox, sandboxId: input.sandboxId, workdir });
  } finally {
    await sandbox.unexpose(PREVIEW_PORT).catch(() => undefined);
    await proc.kill?.().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

export async function gotoPreview(
  page: PreviewPuppeteerPage,
  previewUrl: string,
  path: string,
  timeoutMs = NAV_TIMEOUT_MS,
): Promise<void> {
  const base = new URL(previewUrl);
  const next = new URL(path.startsWith("/") ? path : `/${path}`, base);
  if (next.origin !== base.origin) {
    throw new Error("E2E path must stay on the preview origin.");
  }
  await page.goto(next.toString(), { waitUntil: "networkidle0", timeout: timeoutMs });
}
