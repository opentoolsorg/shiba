import { describe, expect, it } from "vitest";
import type { ReadRequest } from "@shiba/openconnector-read-gateway";
import type { Env } from "../src/env.js";
import {
  handleFounderAutomaticReadPermit,
  mintAutomaticReadCapabilities,
} from "../src/founder-auto-read-permits.js";

const KEY = "fixture-independent-signing-key-123456789";
const input = (): Omit<ReadRequest, "capabilities"> => ({
  format: "shiba.scheduled-read.v1",
  versionId: "fixture-version",
  manifestDigest: "a".repeat(64),
  grantId: "grant-one",
  grantVersion: 1,
  occurrenceId: "occurrence-one",
  stepId: "step-one",
  stepDigest: "b".repeat(64),
  principal: { kind: "schedule", id: "schedule:grant-one" },
  workspaceId: "workspace-one",
  alias: "fixture",
  connectionId: "connection-one",
  providerConnectionId: "provider-one",
  authorizationFingerprint: "c".repeat(64),
  operationId: "figma.get_file_metadata",
  arguments: { fileKey: "file-one" },
  expiresAt: Date.now() + 15000,
  maxBytes: 16384,
  maxDurationMs: 5000,
});
const encode = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const decode = (text: string) => atob(text.replaceAll("-", "+").replaceAll("_", "/"));
async function permit(env: Env, capability: string, requestDigest: string) {
  const response = await handleFounderAutomaticReadPermit(
    new Request("https://shiba.test/internal/founder-automatic-read/permit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stage: "claim", capability, requestDigest }),
    }),
    env,
  );
  if (!response) throw new Error("Permit endpoint did not match");
  return response;
}

describe("automatic read capability signing", () => {
  it.each([undefined, "", "short", " ".repeat(32)])(
    "returns the authority-unavailable 503 for an unusable key (%s)",
    async (key) => {
      await expect(
        mintAutomaticReadCapabilities(
          { INTERNAL_SIGNING_KEY: key } as Env,
          input(),
          "d".repeat(64),
        ),
      ).rejects.toMatchObject({ code: "automatic_read_authority_unavailable", status: 503 });
    },
  );

  it("accepts the versioned text format in strict mode and rejects raw 32-byte legacy MACs", async () => {
    const env = { INTERNAL_SIGNING_KEY: KEY, SHIBA_LEGACY_SIGNING_FALLBACK: "0" } as Env;
    const minted = await mintAutomaticReadCapabilities(env, input(), "d".repeat(64));
    const [payload, signature] = minted.capabilities.claim.split(".") as [string, string];
    expect(decode(signature)).toMatch(/^v1:[a-f0-9]{16}:[a-f0-9]{64}$/);
    // Reaching availability proves verification passed without needing a database fixture.
    const current = await permit(env, minted.capabilities.claim, minted.requestDigest);
    expect(current.status).toBe(503);
    expect(await current.json()).toEqual({ error: "automatic_reads_disabled" });

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(KEY),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        encoder.encode(`shiba:auto-read-capability:v1\n${payload}`),
      ),
    );
    expect(mac.length).toBe(32);
    const legacy = `${payload}.${encode(mac)}`;
    const strict = await permit(env, legacy, minted.requestDigest);
    expect(strict.status).toBe(403);
    expect(await strict.json()).toEqual({ error: "Forbidden." });
    const grace = await permit(
      { ...env, SHIBA_LEGACY_SIGNING_FALLBACK: "1" },
      legacy,
      minted.requestDigest,
    );
    expect(grace.status).toBe(503);
    expect(await grace.json()).toEqual({ error: "automatic_reads_disabled" });
  });
});
