import { getAgentByName } from "agents/routing";
import { AUTOMATIONS_DO_NAME } from "../automation-runner.js";
import { LOCAL_DISPATCH_DO_NAME } from "@shiba/shared";
import type { Env } from "../env.js";

export interface DoScope {
  workspaceId?: string;
  threadKey?: string;
  ownerId?: string;
}

const DEFAULT_WORKSPACE = "owner-default";
const DEFAULT_OWNER = "owner-default";

function scoped(env: Pick<Env, "SHIBA_SCOPED_DO">): boolean {
  return env.SHIBA_SCOPED_DO === "1";
}

export function orchestratorNameFor(env: Pick<Env, "SHIBA_SCOPED_DO">, scope: DoScope): string {
  if (!scoped(env)) return "default";
  const workspaceId = scope.workspaceId?.trim() || DEFAULT_WORKSPACE;
  return scope.threadKey?.trim()
    ? `ws:${workspaceId}:thread:${scope.threadKey.trim()}`
    : `ws:${workspaceId}`;
}

export function automationsNameFor(env: Pick<Env, "SHIBA_SCOPED_DO">, scope: DoScope): string {
  if (!scoped(env)) return AUTOMATIONS_DO_NAME;
  return `ws:${scope.workspaceId?.trim() || DEFAULT_WORKSPACE}`;
}

export function localDispatchNameFor(env: Pick<Env, "SHIBA_SCOPED_DO">, scope: DoScope): string {
  if (!scoped(env)) return LOCAL_DISPATCH_DO_NAME;
  return `dev:${scope.ownerId?.trim() || DEFAULT_OWNER}`;
}

export async function orchestratorFor(env: Env, scope: DoScope) {
  return getAgentByName(env.CodingOrchestrator, orchestratorNameFor(env, scope));
}

export function automationsFor(env: Env, scope: DoScope) {
  return env.Automations.get(env.Automations.idFromName(automationsNameFor(env, scope)));
}

export function localDispatchFor(env: Pick<Env, "LocalDispatch" | "SHIBA_SCOPED_DO">, scope: DoScope) {
  if (!env.LocalDispatch) throw new Error("LocalDispatch binding is not configured.");
  return env.LocalDispatch.get(env.LocalDispatch.idFromName(localDispatchNameFor(env, scope)));
}
