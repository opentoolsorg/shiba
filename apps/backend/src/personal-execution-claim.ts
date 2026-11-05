import { getAgentByName } from "agents";
import { personalExecutionClaimSchema, stableHash, type PersonalExecutionClaim, type JsonValue } from "@shiba/shared";
import type { Env } from "./env.js";
import { signInternalRequest } from "./edge-identity.js";
import { parseSessionAgentName } from "./web-sessions.js";

export function personalClaimPrincipal(proof: PersonalExecutionClaim): string {
  return `personal-claim:${stableHash(proof as unknown as JsonValue)}`;
}

/** Check only the exact isolated approval host. A claim never creates or approves work. */
export async function validatePersonalExecutionClaim(env: Env, candidate: unknown): Promise<boolean> {
  const parsed = personalExecutionClaimSchema.safeParse(candidate);
  if (!parsed.success || env.SHIBA_PERSONAL_LOCAL_EXECUTION !== "1" || (env.INTERNAL_SIGNING_KEY?.trim().length ?? 0) < 32) return false;
  const proof = parsed.data, session = parseSessionAgentName(proof.executionOwner);
  if (!session || session.userId !== proof.snapshot.actorId || proof.approvedUntil <= Date.now() ||
    proof.approvedUntil > proof.snapshot.expiresAt || !/^[a-f0-9]{64}$/.test(proof.inputHash) || !/^[a-f0-9]{64}$/.test(proof.contextDigest)) return false;
  try {
    const request = new Request("https://internal/internal/personal-execution/claim-authority", {
      method: "POST", headers: { "content-type": "application/json", "X-Agent-Principal": personalClaimPrincipal(proof) }, body: JSON.stringify(proof),
    });
    await signInternalRequest(request, env);
    const host = await getAgentByName(env.CodingOrchestrator, proof.executionOwner);
    const response = await host.fetch(request);
    if (!response.ok) return false;
    const result = await response.json() as { authorized?: unknown; inputHash?: unknown };
    return result.authorized === true && result.inputHash === proof.inputHash && proof.approvedUntil > Date.now();
  } catch { return false; }
}
