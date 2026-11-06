import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";

vi.mock("../src/request-auth.js", () => ({
  isAuthorizedRequest: vi.fn(async () => true),
  resolveUserId: vi.fn(async () => "owner@example.test"),
}));
vi.mock("../src/sandbox-routes.js", () => ({
  isValidSandboxId: (id: string) => /^[a-z0-9][a-z0-9-]{0,62}$/i.test(id),
}));

const { handleE2eEvidence } = await import("../src/e2e-evidence-routes.js");
const { isAuthorizedRequest, resolveUserId } = await import("../src/request-auth.js");

beforeEach(() => {
  vi.mocked(isAuthorizedRequest).mockResolvedValue(true);
  vi.mocked(resolveUserId).mockResolvedValue("owner@example.test");
});

describe("handleE2eEvidence", () => {
  it("serves a stored manifest", async () => {
    const manifest = JSON.stringify({ ok: true, frames: [] });
    const env = {
      ATTACHMENTS: {
        get: vi.fn(async (key: string) =>
          key === "e2e/sbx/manifest.json" ? { body: manifest, size: manifest.length, customMetadata: { accessAgent: "owner@example.test" } } : null,
        ),
      },
    } as unknown as Env;
    const res = await handleE2eEvidence(
      new Request("https://worker/api/e2e-evidence/sbx/manifest.json"),
      env,
    );
    expect(res?.status).toBe(200);
    expect(res?.headers.get("Content-Type")).toBe("application/json");
  });

  it("refuses path traversal in frame names", async () => {
    const env = { ATTACHMENTS: { get: vi.fn() } } as unknown as Env;
    const res = await handleE2eEvidence(
      new Request("https://worker/api/e2e-evidence/sbx/..%2Fsecret"),
      env,
    );
    expect(res?.status).toBe(400);
  });
});


describe("E2E evidence owner isolation", () => {
  it("returns no private manifest to another signed-in owner", async () => {
    const privateManifest = JSON.stringify({ private: "do not disclose" });
    const get = vi.fn(async () => ({ body: privateManifest, size: privateManifest.length, customMetadata: { accessAgent: "other-owner@example.test" } }));
    const response = await handleE2eEvidence(new Request("https://worker/api/e2e-evidence/sbx/manifest.json"), { ATTACHMENTS: { get } } as unknown as Env);
    expect(response?.status).toBe(404);
    expect(await response?.text()).not.toContain("do not disclose");
  });

  it("denies an unauthenticated request before reading storage", async () => {
    vi.mocked(isAuthorizedRequest).mockResolvedValue(false);
    const get = vi.fn();
    const response = await handleE2eEvidence(new Request("https://worker/api/e2e-evidence/sbx/manifest.json"), { ATTACHMENTS: { get } } as unknown as Env);
    expect(response?.status).toBe(401);
    expect(get).not.toHaveBeenCalled();
  });
});
