/**
 * Subagent tree vocabulary (Phase 2b). Pure helpers — no I/O.
 * Mirrors Capy semantics: dotted path, depth cap, fresh vs shared sandbox.
 */
import type { DelegatedRun } from "./runs.js";

/** Maximum nesting depth (root = 0, first child = 1, …). */
export const MAX_SUBAGENT_DEPTH = 3;

export type SubagentSandboxMode = "fresh" | "shared";

export interface SubagentLineage {
  parentRunId: string;
  /** Dotted index path from the root, e.g. "1", "1.2", "1.2.1". */
  path: string;
  sandboxMode: SubagentSandboxMode;
}

/** Depth of a dotted path (segments minus one). Root spawns use depth 1. */
export function subagentDepth(path: string): number {
  const trimmed = path.trim();
  if (!trimmed) return 0;
  return trimmed.split(".").length;
}

/** Whether another child may be spawned under `parentPath`. */
export function canSpawnSubagentAt(parentPath: string | undefined): boolean {
  const depth = parentPath === undefined || parentPath === "" ? 0 : subagentDepth(parentPath);
  return depth < MAX_SUBAGENT_DEPTH;
}

/** Next child path: first child of root is "1"; under "1.2" the next sibling is "1.3". */
export function nextSubagentPath(parentPath: string | undefined, existingChildPaths: string[]): string {
  const prefix = parentPath === undefined || parentPath === "" ? "" : `${parentPath}.`;
  let maxIndex = 0;
  for (const child of existingChildPaths) {
    if (!child.startsWith(prefix)) continue;
    const rest = child.slice(prefix.length);
    const segment = rest.split(".")[0];
    const index = Number(segment);
    if (Number.isInteger(index) && index > maxIndex) maxIndex = index;
  }
  return `${prefix}${maxIndex + 1}`;
}

/** List direct child paths of `parentPath` from a flat run list. */
export function directChildPaths(parentPath: string | undefined, runs: DelegatedRun[]): string[] {
  const prefix = parentPath === undefined || parentPath === "" ? "" : `${parentPath}.`;
  const out: string[] = [];
  for (const run of runs) {
    const path = run.subagentPath;
    if (!path) continue;
    if (parentPath === undefined || parentPath === "") {
      if (!path.includes(".")) out.push(path);
      continue;
    }
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (!rest.includes(".")) out.push(path);
  }
  return out;
}

/**
 * Resolve the sandbox id a subagent run should use.
 * Shared mode reuses the parent's container; fresh mints a new id via the caller's nonce.
 */
export function resolveSubagentSandboxId(
  parent: Pick<DelegatedRun, "sandboxId" | "runId">,
  mode: SubagentSandboxMode,
  freshSandboxId: string,
): string {
  return mode === "shared" ? parent.sandboxId : freshSandboxId;
}

/** True when the run is a subagent (has lineage). */
export function isSubagentRun(run: DelegatedRun): boolean {
  return run.parentRunId !== undefined && run.subagentPath !== undefined;
}
