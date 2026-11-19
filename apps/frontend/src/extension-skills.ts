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

async function request(url: string, init?: RequestInit, scope: ExtensionSkillRequestScope = {}): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (scope.workspaceId) headers.set("X-Shiba-Workspace", scope.workspaceId);
  const response = await fetch(url, {
    credentials: "same-origin",
    cache: "no-store",
    ...init,
    headers,
    ...(scope.signal ? { signal: scope.signal } : {}),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    const message = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
      ? body.error
      : `Skills request failed (${response.status}).`;
    throw new ExtensionSkillRequestError(message, response.status);
  }
  return response;
}

async function requestJson<T>(url: string, init?: RequestInit, scope?: ExtensionSkillRequestScope): Promise<T> {
  return (await request(url, init, scope)).json().catch(() => null) as Promise<T>;
}

export async function importExtensionSkill(selection: File[], scope: ExtensionSkillScope, options: ExtensionSkillRequestScope): Promise<void> {
  if (!selection.length || selection.length > 64 || selection.reduce((size, file) => size + file.size, 0) > 512 * 1024) {
    throw new Error("Choose up to 64 files totaling no more than 512 KiB.");
  }
  const folder = selection[0]?.webkitRelativePath.split("/")[0] || "skill";
  const files = await Promise.all(selection.map(async (file) => {
    const relative = file.webkitRelativePath;
    if (relative && !relative.startsWith(`${folder}/`)) throw new Error("Choose one skill folder.");
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    }
    return { path: relative ? relative.slice(folder.length + 1) : file.name, base64: btoa(binary) };
  }));
  await requestJson(`${BASE}/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ folder, files, scope }),
  }, options);
}

export async function downloadExtensionSkill(id: string, scope: ExtensionSkillRequestScope): Promise<void> {
  const response = await request(`${BASE}/${encodeURIComponent(id)}/folder`, undefined, scope);
  if (response.headers.get("content-type") !== "application/zip") throw new Error("Skill folder could not be downloaded.");
  const blob = await response.blob();
  scope.signal?.throwIfAborted();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "skill-folder.zip";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function fetchExtensionSkillCatalog(scope: ExtensionSkillRequestScope) {
  const body = await requestJson<{ skills?: Array<{ slug: string; name: string; summary: string; tags: string[] }> }>(`${BASE}/catalog`, undefined, scope);
  if (!Array.isArray(body?.skills)) throw new Error("Skill catalog could not be loaded.");
  return body.skills;
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
