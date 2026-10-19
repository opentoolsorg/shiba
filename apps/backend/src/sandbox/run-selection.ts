import type { DelegatedRun } from "../runs.js";
import type { SandboxSelectionContext } from "./selection.js";

export function sandboxSelectionForRun(
  run: Pick<DelegatedRun, "sandboxProvider" | "customAgentId">,
  orgId = "self-hosted",
): SandboxSelectionContext {
  return {
    orgId,
    ...(run.sandboxProvider ? { taskProviderId: run.sandboxProvider } : {}),
    ...(run.customAgentId ? { customAgentProviderId: undefined } : {}),
  };
}
