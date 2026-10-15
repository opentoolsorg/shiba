import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { handleSwarm } from "../src/swarm-routes.js";
import { signShareToken, verifyShareToken } from "../../../packages/shared/src/swarm-share.js";

const NOW = 1_700_000_000;
const SECRET = "test-secret";

function makeEnv(secret?: string): Env {
  return (secret === undefined ? {} : { SWARM_SHARE_SECRET: secret }) as Env;
}

function post(path: string, body: unknown): Request {
  return new Request(`https://worker.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("swarm routes", () => {
  it("returns null for an unrelated path", async () => {
    await expect(handleSwarm(new Request("https://worker.test/api/other"), makeEnv(), {})).resolves.toBeNull();
  });

  it("requires authorization to create a share link", async () => {
    const response = await handleSwarm(
      post("/api/swarm/share", { runId: "run_1" }),
      makeEnv(SECRET),
      { isAuthorized: async () => false, loadRun: async () => null, nowSeconds: () => NOW },
    );

    expect(response?.status).toBe(401);
    await expect(response?.json()).resolves.toEqual({ error: "Authentication required." });
  });

  it("returns 503 when share links are not configured", async () => {
    const response = await handleSwarm(
      post("/api/swarm/share", { runId: "run_1" }),
      makeEnv(),
      { isAuthorized: async () => true, loadRun: async () => null, nowSeconds: () => NOW },
    );

    expect(response?.status).toBe(503);
    await expect(response?.json()).resolves.toEqual({ error: "Set SWARM_SHARE_SECRET to mint share links." });
  });

  it("mints a seven-day share link whose token verifies", async () => {
    const response = await handleSwarm(
      post("/api/swarm/share", { runId: "run_1" }),
      makeEnv(SECRET),
      { isAuthorized: async () => true, loadRun: async () => null, nowSeconds: () => NOW },
    );

    expect(response?.status).toBe(200);
    const body = (await response?.json()) as { url: string; exp: number };
    expect(body.exp).toBe(1_700_604_800);
    const token = new URL(body.url).pathname.split("/").at(-1);
    expect(token).toBeTruthy();
    await expect(verifyShareToken(SECRET, token!, NOW)).resolves.toMatchObject({
      exp: 1_700_604_800,
      runId: "run_1",
      userId: "default",
    });
  });

  it("returns 404 for an invalid share token", async () => {
    const response = await handleSwarm(
      new Request("https://worker.test/api/swarm/share/not-a-valid-token"),
      makeEnv(SECRET),
      { isAuthorized: async () => false, loadRun: async () => null, nowSeconds: () => NOW },
    );

    expect(response?.status).toBe(404);
  });

  it("returns 404 when the run for a valid token is missing", async () => {
    const token = await signShareToken(SECRET, { runId: "run_1", userId: "user_1" }, 604_800, NOW);
    const response = await handleSwarm(
      new Request(`https://worker.test/api/swarm/share/${token}`),
      makeEnv(SECRET),
      { isAuthorized: async () => false, loadRun: async () => null, nowSeconds: () => NOW },
    );

    expect(response?.status).toBe(404);
  });

  it("redacts diff from a shared run", async () => {
    const token = await signShareToken(SECRET, { runId: "run_1", userId: "user_1" }, 604_800, NOW);
    const response = await handleSwarm(
      new Request(`https://worker.test/api/swarm/share/${token}`),
      makeEnv(SECRET),
      {
        isAuthorized: async () => false,
        loadRun: async () => ({
          runId: "run_1",
          task: "Fix login",
          repoUrl: "https://github.com/example/repo",
          status: "completed",
          baseBranch: "main",
          updatedAt: NOW,
          diff: "private diff",
        }),
        nowSeconds: () => NOW,
      },
    );

    expect(response?.status).toBe(200);
    const body = (await response?.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("diff");
    expect(body).toMatchObject({ runId: "run_1", task: "Fix login" });
  });

  it("normalizes plain-text Linear intake", async () => {
    const response = await handleSwarm(
      post("/api/swarm/intake", { text: "ENG-1: Broken login", webhook: false }),
      makeEnv(),
      { isAuthorized: async () => true, loadRun: async () => null, nowSeconds: () => NOW },
    );

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({ source: "linear" });
  });
});
