import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";

vi.mock("../src/request-auth.js", () => ({
  isAuthorizedRequest: vi.fn(async () => true),
}));
vi.mock("../src/sandbox-routes.js", () => ({
  isValidSandboxId: (id: string) => /^[a-z0-9][a-z0-9-]{0,62}$/i.test(id),
}));

const { handleE2eEvidence } = await import("../src/e2e-evidence-routes.js");

describe("handleE2eEvidence", () => {
  it("serves a stored manifest", async () => {
    const manifest = JSON.stringify({ ok: true, frames: [] });
    const env = {
      ATTACHMENTS: {
        get: vi.fn(async (key: string) =>
          key === "e2e/sbx/manifest.json" ? { body: manifest, size: manifest.length } : null,
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
