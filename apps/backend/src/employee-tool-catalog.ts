import { projectRegisteredTools } from "./capability-catalog.js";
import {
  selectEmployeeCapabilities,
  type EmployeeToolAuthority,
} from "./employee-tool-policy.js";

/** Bounded schema projection for exactly the effective employee capability set. */
export async function buildEmployeeToolCatalog(
  authority: EmployeeToolAuthority,
  options: { limit?: number } = {},
) {
  const selection = selectEmployeeCapabilities(authority, options);
  const entries = await projectRegisteredTools(
    authority.registeredTools,
    authority.principal,
    new Set(selection.allowedCapabilityIds),
  );
  return {
    version: selection.version,
    employee: { id: selection.employeeId, version: selection.employeeVersion },
    entries,
    totalAuthorized: selection.totalEligible,
    returned: entries.length,
    truncated: selection.truncated,
    liveChecksPerformed: false as const,
  };
}
