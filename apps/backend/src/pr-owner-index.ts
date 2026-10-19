import { prOwnerStorageKey, type PrOwnerRecord } from "@shiba/shared";
import { automationsStub } from "./automations-stub.js";
import type { Env } from "./env.js";

export async function registerPrOwner(
  env: Env,
  input: { repoFullName: string; pullNumber: number; agentName: string; codingRunId: string },
): Promise<void> {
  const response = await automationsStub(env).fetch(
    new Request("https://internal/internal/pr-owner", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, updatedAt: Date.now() }),
    }),
  );
  if (!response.ok) {
    throw new Error(`pr-owner register failed (${response.status})`);
  }
}

export async function readPrOwner(
  env: Env,
  repoFullName: string,
  pullNumber: number,
): Promise<PrOwnerRecord | null> {
  const url = new URL("https://internal/internal/pr-owner");
  url.searchParams.set("repo", repoFullName);
  url.searchParams.set("pull", String(pullNumber));
  const response = await automationsStub(env).fetch(new Request(url, { method: "GET" }));
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`pr-owner read failed (${response.status})`);
  const body = (await response.json()) as { owner?: PrOwnerRecord };
  return body.owner ?? null;
}

export { prOwnerStorageKey };
