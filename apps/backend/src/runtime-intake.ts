import { LOCAL_INTAKE_DASHBOARD } from "@shiba/shared";
import type { ExecutionTarget } from "@shiba/shared";
import type { Env } from "./env.js";
import { resolveRuntimeName } from "./runtime.js";

/**
 * Resolve and freeze the runtime that will execute after approval. Non-dashboard
 * intake never inherits a deployment default of `local`; explicit `sandbox`
 * selections are preserved instead of falling through to RUNTIME at dispatch.
 */
export function freezeRuntimeForApproval(
  env: Env,
  input: {
    runtime?: unknown;
    intake?: unknown;
    executionTarget?: ExecutionTarget;
  },
): "sandbox" | "local" {
  const runtimeRaw = typeof input.runtime === "string" ? input.runtime.trim() : "";
  if (runtimeRaw === "local") return "local";
  if (runtimeRaw === "sandbox") return "sandbox";
  if (input.executionTarget?.kind === "artifact-workspace") return "sandbox";
  if (input.intake !== LOCAL_INTAKE_DASHBOARD) return "sandbox";
  const deployment = resolveRuntimeName(env.RUNTIME);
  return deployment === "local" ? "local" : "sandbox";
}
