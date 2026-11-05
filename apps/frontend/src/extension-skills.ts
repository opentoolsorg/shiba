import type {
  CreateExtensionSkillRequest,
  ExtensionSkillRecord,
  ExtensionSkillScope,
  ExtensionSkillView,
  UpdateExtensionSkillRequest,
} from "@shiba/shared";

export interface ExtensionSkillRequestScope { workspaceId?: string; signal?: AbortSignal }
export class ExtensionSkillRequestError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}

const BASE = "/api/v1/extensions/skills";

async function requestJson<T>(url: string, init?: RequestInit, scope: ExtensionSkillRequestScope = {}): Promise<T> {
  const headers = new Headers(init?.headers);
  if (scope.workspaceId) headers.set("X-Shiba-Workspace", scope.workspaceId);
  const response = await fetch(url, {
    credentials: "same-origin",
    cache: "no-store",
    ...init,
    headers,
    ...(scope.signal ? { signal: scope.signal } : {}),
  });
  const body = await response.json().catch(() => null) as T | { error?: string } | null;
  if (!response.ok) {
    const message = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
      ? body.error
      : `Skills request failed (${response.status}).`;
    throw new ExtensionSkillRequestError(message, response.status);
  }
  return body as T;
}

export async function fetchExtensionSkills(view: ExtensionSkillView, scope: ExtensionSkillRequestScope = {}): Promise<ExtensionSkillRecord[]> {
  const rows = await requestJson<unknown>(`${BASE}?view=${encodeURIComponent(view)}`, undefined, scope);
  if (!Array.isArray(rows)) throw new Error("Skills could not be loaded.");
  return rows as ExtensionSkillRecord[];
}

export async function createExtensionSkill(input: CreateExtensionSkillRequest, scope: ExtensionSkillRequestScope = {}): Promise<string> {
  const body = await requestJson<{ id?: unknown }>(BASE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }, scope);
  if (typeof body?.id !== "string") throw new Error("Skill was created without an id.");
  return body.id;
}

export async function updateExtensionSkill(skillId: string, updates: Omit<UpdateExtensionSkillRequest, "skillId">, scope: ExtensionSkillRequestScope = {}): Promise<void> {
  await requestJson<{ success?: boolean }>(`${BASE}/${encodeURIComponent(skillId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(updates),
  }, scope);
}

export async function deleteExtensionSkill(skillId: string, scope: ExtensionSkillRequestScope = {}): Promise<void> {
  await requestJson<{ success?: boolean }>(`${BASE}/${encodeURIComponent(skillId)}`, { method: "DELETE" }, scope);
}

export async function moveExtensionSkill(skillId: string, to: ExtensionSkillScope, scope: ExtensionSkillRequestScope = {}): Promise<void> {
  await requestJson<{ ok?: boolean }>(`${BASE}/${encodeURIComponent(skillId)}/scope`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to }),
  }, scope);
}

export async function archiveExtensionSkill(skillId: string, scope: ExtensionSkillRequestScope = {}): Promise<void> {
  await requestJson<{ ok?: boolean }>(`${BASE}/${encodeURIComponent(skillId)}/archive`, { method: "POST" }, scope);
}

export async function restoreExtensionSkill(skillId: string, scope: ExtensionSkillRequestScope = {}): Promise<void> {
  await requestJson<{ ok?: boolean }>(`${BASE}/${encodeURIComponent(skillId)}/restore`, { method: "POST" }, scope);
}
