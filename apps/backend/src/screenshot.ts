/**
 * PR screenshot capture (megaplan T33). After the coding run completes,
 * serve the workdir over a throwaway static server inside the sandbox,
 * mint a preview URL with `sandbox.exposePort`, render it once through
 * Workers Browser Rendering (puppeteer), and stash the PNG in the
 * ATTACHMENTS bucket keyed `screenshots/{sandboxId}.png`.
 *
 * Every entry point is fail-safe: missing bindings, a dead sandbox, a
 * navigation timeout, or an R2 failure all resolve to `null` — never a
 * thrown error — so capture can never fail a run or its PR publish.
 */
import type { Env } from "./env.js";
import { gotoPreview, withStaticPreview, type StaticPreviewDeps } from "./preview/with-static-preview.js";
import { PREVIEW_PORT } from "./preview/types.js";

export { PREVIEW_PORT };

export interface PreviewCapture {
  /** Public sandbox preview URL (`{port}-{sandboxId}-{token}.{host}`). */
  previewUrl: string;
  /** Absolute URL that serves the stored PNG on this Worker, or null when no hostname is configured. */
  screenshotUrl: string | null;
  /** ATTACHMENTS object key the PNG was written to. */
  screenshotKey: string;
}

export const screenshotKeyFor = (sandboxId: string): string => `screenshots/${sandboxId}.png`;

/** Absolute public URL for a stored screenshot on this Worker. */
export function screenshotUrlFor(env: Env, sandboxId: string): string | null {
  const host = env.WORKER_HOSTNAME?.trim();
  if (!host) return null;
  return `https://${host}/api/screenshots/${encodeURIComponent(sandboxId)}`;
}

export type CaptureDeps = StaticPreviewDeps;

/**
 * Serve `/workspace/{sandboxId}` in the sandbox, expose the preview port,
 * screenshot the page, and store the PNG. Returns null on any failure or
 * when `BROWSER`/`WORKER_HOSTNAME` are unconfigured — the caller never
 * branches on failure because failure and "not configured" look identical.
 */
export async function captureRunPreview(
  env: Env,
  input: { sandboxId: string; workdir?: string },
  deps: CaptureDeps = {},
): Promise<PreviewCapture | null> {
  try {
    if (!env.BROWSER || !env.ATTACHMENTS) return null;
    if (!env.WORKER_HOSTNAME?.trim()) return null;

    let previewUrl = "";
    const png = await withStaticPreview(
      env,
      input,
      async (ctx) => {
        previewUrl = ctx.previewUrl;
        await gotoPreview(ctx.page, ctx.previewUrl, "/", deps.screenshotTimeoutMs ?? undefined);
        return await ctx.page.screenshot({ fullPage: false });
      },
      deps,
    );
    if (!png) return null;

    const screenshotKey = screenshotKeyFor(input.sandboxId);
    await env.ATTACHMENTS.put(screenshotKey, png, {
      httpMetadata: { contentType: "image/png" },
    });
    return {
      previewUrl,
      screenshotUrl: screenshotUrlFor(env, input.sandboxId),
      screenshotKey,
    };
  } catch (error) {
    console.error(
      `Preview screenshot capture failed for sandbox ${input.sandboxId}:`,
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}
