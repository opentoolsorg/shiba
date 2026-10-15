import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { laneForRun } from "../../../packages/shared/src/swarm-desk.js";
import {
  redactShareView,
  signShareToken,
  verifyShareToken,
  type ShareTokenPayload,
} from "../../../packages/shared/src/swarm-share.js";

const SECRET = "test-secret";
const CLAIMS = { runId: "run_1", userId: "user_1" };
const NOW = 1_700_000_000;
const CANONICAL =
  '{"exp":1700003600,"runId":"run_1","sessionId":null,"userId":"user_1"}';
const LOCKED_TOKEN =
  "eyJleHAiOjE3MDAwMDM2MDAsInJ1bklkIjoicnVuXzEiLCJzZXNzaW9uSWQiOm51bGwsInVzZXJJZCI6InVzZXJfMSJ9.2snVxPrw1POfhWfTRhq92H9iZD75ucwaHagNxwMOti0"; // gitleaks:allow — locked contract vector, not a credential

function base64url(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function expectedToken(secret: string, canonical: string): string {
  const signature = createHmac("sha256", secret).update(canonical, "utf8").digest();
  return `${base64url(canonical)}.${base64url(signature)}`;
}

describe("swarm share tokens", () => {
  it("matches the locked vector byte-for-byte and verifies its canonical payload", async () => {
    const payload: ShareTokenPayload = {
      exp: NOW + 3600,
      runId: "run_1",
      sessionId: null,
      userId: "user_1",
    };
    const token = await signShareToken(SECRET, CLAIMS, 3600, NOW);

    expect(JSON.stringify(payload)).toBe(CANONICAL);
    expect(expectedToken(SECRET, CANONICAL)).toBe(LOCKED_TOKEN);
    expect(token).toBe(expectedToken(SECRET, CANONICAL));
    expect(token).toBe(LOCKED_TOKEN);
    expect(await verifyShareToken(SECRET, token, NOW)).toEqual(payload);
  });

  it("returns null when the token has expired at exp", async () => {
    const token = await signShareToken(SECRET, CLAIMS, 3600, NOW);
    expect(await verifyShareToken(SECRET, token, NOW + 3600)).toBeNull();
  });

  it("returns null when a signature byte is flipped", async () => {
    const token = await signShareToken(SECRET, CLAIMS, 3600, NOW);
    const [encodedPayload, encodedSignature] = token.split(".");
    if (!encodedPayload || !encodedSignature) throw new Error("Expected a two-part token");
    const signature = Buffer.from(encodedSignature, "base64url");
    signature[0] = signature[0]! ^ 1;

    expect(await verifyShareToken(SECRET, `${encodedPayload}.${base64url(signature)}`, NOW)).toBeNull();
  });

  it("rejects an empty secret", async () => {
    await expect(signShareToken("", CLAIMS, 3600, NOW)).rejects.toThrow();
    expect(await verifyShareToken("", LOCKED_TOKEN, NOW)).toBeNull();
  });

  it.each([59, 604801])("rejects ttl %i", async (ttl) => {
    await expect(signShareToken(SECRET, CLAIMS, ttl, NOW)).rejects.toThrow();
  });

  it.each([
    { runId: "bad/run", userId: "user_1" },
    { runId: "run_1", userId: "bad user" },
    { runId: "run_1", userId: "user_1", sessionId: "bad_session" },
  ])("rejects invalid claims %s", async (claims) => {
    await expect(signShareToken(SECRET, claims, 3600, NOW)).rejects.toThrow();
  });
});

describe("redactShareView", () => {
  it("drops diff and truncates the summary to 500 characters", () => {
    const result = redactShareView(
      {
        runId: "run_1",
        task: "Inspect",
        status: "completed",
        repoUrl: "https://github.com/acme/project",
        baseBranch: "main",
        updatedAt: NOW,
        summary: "s".repeat(600),
        diff: "private diff",
      },
      laneForRun({ status: "completed" }),
    );

    expect(result.summary).toBe("s".repeat(500));
    expect(result.diff).toBeUndefined();
    expect(result).not.toHaveProperty("diff");
  });

  it("keeps a null screenshotUrl and omits an undefined pullUrl", () => {
    const result = redactShareView(
      {
        runId: "run_1",
        task: "Inspect",
        status: "pending",
        repoUrl: "https://github.com/acme/project",
        baseBranch: "main",
        screenshotUrl: null,
        updatedAt: NOW,
      },
      laneForRun({ status: "pending" }),
    );

    expect(result.screenshotUrl).toBeNull();
    expect(result).not.toHaveProperty("pullUrl");
  });
});
