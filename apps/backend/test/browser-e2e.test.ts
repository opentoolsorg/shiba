import { describe, expect, it, vi } from "vitest";
import { captureBrowserE2eEvidence, formatBrowserE2ePrSection } from "../src/browser-e2e/capture.js";
import { PREVIEW_PORT } from "../src/preview/types.js";
import type { Env } from "../src/env.js";
import type { PreviewSandbox } from "../src/preview/types.js";

vi.mock("@cloudflare/sandbox", () => ({ getSandbox: vi.fn() }));
vi.mock("@cloudflare/puppeteer", () => ({ default: { launch: vi.fn() } }));

function makeEnv(store: Map<string, unknown>): Env {
  return {
    BROWSER: { fetch: vi.fn() } as unknown as Fetcher,
    ATTACHMENTS: {
      put: vi.fn(async (key: string, value: unknown) => {
        store.set(key, value);
      }),
      get: vi.fn(async (key: string) => store.get(key) ?? null),
    } as unknown as R2Bucket,
    WORKER_HOSTNAME: "shiba.example.com",
  } as unknown as Env;
}

function makePage() {
  const requestHandlers: Array<(request: unknown) => void> = [];
  return {
    goto: vi.fn(async () => ({})),
    screenshot: vi.fn(async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
    setRequestInterception: vi.fn(async () => undefined),
    on: vi.fn((_event: string, handler: (request: unknown) => void) => {
      requestHandlers.push(handler);
    }),
    click: vi.fn(async () => undefined),
    type: vi.fn(async () => undefined),
    waitForSelector: vi.fn(async () => ({})),
    evaluate: vi.fn(async () => "hello"),
    requestHandlers,
  };
}

describe("captureBrowserE2eEvidence", () => {
  it("runs the default smoke plan and stores a manifest", async () => {
    const store = new Map<string, unknown>();
    const env = makeEnv(store);
    const page = makePage();
    const proc = { waitForPort: vi.fn(async () => undefined), kill: vi.fn(async () => undefined) };
    const sandbox: PreviewSandbox = {
      exec: vi.fn(async () => ({ exitCode: 1, stdout: "" })),
      startProcess: vi.fn(async () => proc),
      expose: vi.fn(async () => ({
        url: `https://${PREVIEW_PORT}-sandbox-abc-tok.shiba.example.com`,
      })),
      unexpose: vi.fn(async () => undefined),
    };
    const launch = vi.fn(async () => ({
      newPage: vi.fn(async () => page),
      close: vi.fn(async () => undefined),
    }));

    const capture = await captureBrowserE2eEvidence(
      env,
      { sandboxId: "sandbox-abc" },
      { sandbox, launch },
    );

    expect(capture?.manifest.ok).toBe(true);
    expect(capture?.manifest.frames.length).toBeGreaterThan(0);
    expect(capture?.manifestUrl).toContain("/api/e2e-evidence/sandbox-abc/manifest.json");
    expect(store.has("e2e/sandbox-abc/manifest.json")).toBe(true);
    const section = formatBrowserE2ePrSection(capture!);
    expect(section).toContain("Browser E2E evidence");
    expect(section).not.toContain("tok.shiba.example.com");
  });

  it("uses an agent-authored plan file when present", async () => {
    const store = new Map<string, unknown>();
    const env = makeEnv(store);
    const page = makePage();
    const proc = { waitForPort: vi.fn(async () => undefined), kill: vi.fn(async () => undefined) };
    const planJson = JSON.stringify({
      title: "agent",
      steps: [{ kind: "goto", path: "/index.html" }, { kind: "screenshot", name: "idx" }],
    });
    const sandbox: PreviewSandbox = {
      exec: vi.fn(async (command) =>
        command.includes(".shiba/browser-e2e.json")
          ? { exitCode: 0, stdout: planJson }
          : { exitCode: 1, stdout: "" },
      ),
      startProcess: vi.fn(async () => proc),
      expose: vi.fn(async () => ({
        url: `https://${PREVIEW_PORT}-sandbox-abc-tok.shiba.example.com`,
      })),
      unexpose: vi.fn(async () => undefined),
    };
    const launch = vi.fn(async () => ({
      newPage: vi.fn(async () => page),
      close: vi.fn(async () => undefined),
    }));

    const capture = await captureBrowserE2eEvidence(env, { sandboxId: "sandbox-abc" }, { sandbox, launch });
    expect(capture?.manifest.planTitle).toBe("agent");
    expect(page.goto).toHaveBeenCalled();
  });
});
