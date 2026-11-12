import type { LoadState, SetupStatus } from "./live-status";

export interface TaskRouteSelection {
  harness?: string;
  codingModel?: string;
  connectionId?: string;
  runTarget?: "sandbox" | "local";
}

/** Only gate on diagnostics for the selected route, never a global gateway flag. */
export function taskReadiness(state: LoadState<SetupStatus>, route: TaskRouteSelection): { blocked: boolean; message: string } {
  if (route.runTarget === "local") return { blocked: false, message: "Local runs use the paired computer's provider setup. The server checks the computer and approval before starting." };
  if (state.kind === "loading") return { blocked: true, message: "Checking model setup before handoff…" };
  if (state.kind === "error") return { blocked: true, message: "Unable to check model setup. Retry the check or open Settings → Models." };
  if (!state.data.models || !Array.isArray(state.data.doctor?.roles)) return { blocked: true, message: "Model setup diagnostics are unavailable. Retry the check or open Settings → Models." };
  const harness = route.harness || state.data.models.harness;
  const model = route.codingModel || state.data.models.coding;
  const row = state.data.doctor.roles.find((entry) => entry.harness === harness && entry.model === model && (entry.connectionId ?? "") === (route.connectionId || ""));
  if (!row) return { blocked: false, message: "This model override has not been checked by setup diagnostics. The server validates it before approval." };
  if (!row.ok) return { blocked: true, message: `${row.message || "The selected model route needs setup."} ${row.fix || "Open Settings → Models to finish setup."}` };
  return { blocked: false, message: "Selected model route setup checks passed. Repository access and approval are still checked before work starts." };
}
