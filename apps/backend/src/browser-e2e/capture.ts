/**
 * Phase 3 — agent-authored browser E2E via Workers Browser Rendering (CDP).
 * Plans live in `.shiba/browser-e2e.json` (or `shiba-browser-e2e.json`);
 * when missing, a minimal smoke plan runs. Evidence (frame PNGs + manifest)
 * is stored in R2 and linked from the published PR body.
 */
import {
  BROWSER_E2E_PLAN_PATHS,
  DEFAULT_BROWSER_E2E_PLAN,
  type BrowserE2eFrame,
  type BrowserE2eManifest,
  type BrowserE2ePlan,
  type BrowserE2eStep,
  parseBrowserE2ePlan,
} from "@shiba/shared";
import type { Env } from "../env.js";
import { gotoPreview, withStaticPreview, type StaticPreviewDeps } from "../preview/with-static-preview.js";
import type { PreviewPuppeteerPage, PreviewSandbox } from "../preview/types.js";
import { e2eFrameKey, e2eFrameUrlFor, e2eManifestKey, e2eManifestUrlFor } from "./evidence-urls.js";

const STEP_TIMEOUT_MS = 30_000;

export interface BrowserE2eCapture {
  manifestUrl: string | null;
  manifestKey: string;
  manifest: BrowserE2eManifest;
}

export interface BrowserE2eCaptureDeps extends StaticPreviewDeps {
  sandbox?: PreviewSandbox;
  now?: () => number;
}

async function readPlanFromWorkdir(
  sandbox: PreviewSandbox,
  workdir: string,
): Promise<BrowserE2ePlan | null> {
  for (const rel of BROWSER_E2E_PLAN_PATHS) {
    const quoted = rel.replace(/'/g, "'\\''");
    const result = await sandbox.exec(`cat '${quoted}'`, { cwd: workdir, timeout: 10_000 });
    if (result.exitCode !== 0 || !result.stdout?.trim()) continue;
    try {
      const parsed = parseBrowserE2ePlan(JSON.parse(result.stdout));
      if (parsed.plan) return parsed.plan;
    } catch {
      continue;
    }
  }
  return null;
}

async function runStep(
  page: PreviewPuppeteerPage,
  previewUrl: string,
  step: BrowserE2eStep,
): Promise<void> {
  switch (step.kind) {
    case "goto":
      await gotoPreview(page, previewUrl, step.path, STEP_TIMEOUT_MS);
      return;
    case "click":
      await page.click(step.selector, { timeout: STEP_TIMEOUT_MS });
      return;
    case "fill":
      await page.click(step.selector, { timeout: STEP_TIMEOUT_MS });
      await page.type(step.selector, step.text, { delay: 15 });
      return;
    case "wait":
      await page.waitForSelector(step.selector, {
        timeout: step.timeoutMs ?? STEP_TIMEOUT_MS,
        visible: true,
      });
      return;
    case "assert_visible":
      await page.waitForSelector(step.selector, { timeout: STEP_TIMEOUT_MS, visible: true });
      return;
    case "assert_text": {
      const text = await page.evaluate((selector) => {
        const el = document.querySelector(selector);
        return el?.textContent ?? "";
      }, step.selector);
      if (!text.includes(step.includes)) {
        throw new Error(`assert_text failed for ${step.selector}`);
      }
      return;
    }
    case "screenshot":
      return;
    default:
      throw new Error("Unknown E2E step.");
  }
}

export async function captureBrowserE2eEvidence(
  env: Env,
  input: { sandboxId: string; workdir?: string; plan?: BrowserE2ePlan },
  deps: BrowserE2eCaptureDeps = {},
): Promise<BrowserE2eCapture | null> {
  if (!env.ATTACHMENTS) return null;
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();

  let manifest: BrowserE2eManifest = {
    sandboxId: input.sandboxId,
    planTitle: DEFAULT_BROWSER_E2E_PLAN.title ?? "smoke",
    startedAt,
    finishedAt: startedAt,
    ok: false,
    stepsRun: 0,
    frames: [],
  };

  const result = await withStaticPreview(
    env,
    input,
    async ({ previewUrl, page, sandbox, sandboxId, workdir }) => {
      const authored = input.plan ?? (await readPlanFromWorkdir(sandbox, workdir));
      const resolved = authored ?? DEFAULT_BROWSER_E2E_PLAN;
      manifest.planTitle = resolved.title ?? (authored ? "agent" : "smoke");
      manifest.previewOrigin = new URL(previewUrl).origin;

      const frames: BrowserE2eFrame[] = [];
      let frameIndex = 0;
      let stepsRun = 0;

      try {
        for (const step of resolved.steps) {
          await runStep(page, previewUrl, step);
          stepsRun += 1;
          if (step.kind === "screenshot" || step.kind === "goto" || step.kind === "assert_visible") {
            const name =
              step.kind === "screenshot"
                ? step.name
                : step.kind === "goto"
                  ? `after-goto-${frameIndex}`
                  : `after-visible-${frameIndex}`;
            const png = await page.screenshot({ fullPage: false, type: "png" });
            const key = e2eFrameKey(sandboxId, name, frameIndex);
            await env.ATTACHMENTS.put(key, png, { httpMetadata: { contentType: "image/png" } });
            const fileName = key.split("/").pop() ?? `${frameIndex}.png`;
            frames.push({
              name,
              key,
              url: e2eFrameUrlFor(env, sandboxId, fileName),
              at: now(),
            });
            frameIndex += 1;
          }
        }

        manifest = {
          ...manifest,
          ok: true,
          stepsRun,
          frames,
          finishedAt: now(),
        };
      } catch (error) {
        manifest = {
          ...manifest,
          ok: false,
          stepsRun,
          frames,
          finishedAt: now(),
          error: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240),
        };
      }
      return manifest;
    },
    deps,
  );

  if (!result) return null;

  const manifestKey = e2eManifestKey(input.sandboxId);
  await env.ATTACHMENTS.put(manifestKey, JSON.stringify(result), {
    httpMetadata: { contentType: "application/json" },
  });

  return {
    manifest: result,
    manifestKey,
    manifestUrl: e2eManifestUrlFor(env, input.sandboxId),
  };
}

/** PR-safe markdown section — never includes the tokenized preview URL. */
export function formatBrowserE2ePrSection(capture: BrowserE2eCapture): string {
  const { manifest, manifestUrl } = capture;
  const lines = ["", "**Browser E2E evidence:**"];
  if (manifestUrl) {
    lines.push(`- [Frame manifest](${manifestUrl}) (${manifest.frames.length} frames, ${manifest.stepsRun} steps)`);
  } else {
    lines.push(`- Frame manifest stored (${manifest.frames.length} frames, ${manifest.stepsRun} steps)`);
  }
  const gallery = manifest.frames.filter((f) => f.url).slice(0, 6);
  for (const frame of gallery) {
    lines.push(`- ![${frame.name}](${frame.url})`);
  }
  if (!manifest.ok && manifest.error) {
    lines.push(`- Status: failed (${manifest.error})`);
  }
  return lines.join("\n");
}
