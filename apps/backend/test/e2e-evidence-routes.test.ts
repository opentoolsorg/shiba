import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";

const auth = vi.hoisted(() => ({ userId: "owner@example.test", authorized: true }));
vi.mock("../src/request-auth.js", () => ({
  isAuthorizedRequest: vi.fn(async () => auth.authorized),
  resolveUserId: vi.fn(async () => auth.userId),
}));
vi.mock("../src/sandbox-routes.js", () => ({
  isValidSandboxId: (id: string) => /^[a-z0-9][a-z0-9-]{0,62}$/i.test(id),
}));

const { handleE2eEvidence } = await import("../src/e2e-evidence-routes.js");

beforeEach(() => { auth.userId = "owner@example.test"; auth.authorized = true; });

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

  it("does not serve another owner's stored manifest", async () => {
    auth.userId = "other@example.test";
    const env = { ATTACHMENTS: { get: vi.fn(async () => ({
      body: "private-evidence-body", size: 21, customMetadata: { accessAgent: "owner@example.test" },
    })) } } as unknown as Env;
    const res = await handleE2eEvidence(new Request("https://worker/api/e2e-evidence/sbx/manifest.json"), env);
    expect(res?.status).toBe(404);
    expect(await res?.text()).not.toContain("private-evidence-body");
  });

  it("rejects unauthenticated artifact access before reading storage", async () => {
    auth.authorized = false;
    const get = vi.fn();
    const env = { ATTACHMENTS: { get } } as unknown as Env;
    const res = await handleE2eEvidence(new Request("https://worker/api/e2e-evidence/sbx/manifest.json"), env);
    expect(res?.status).toBe(401);
    expect(get).not.toHaveBeenCalled();
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
