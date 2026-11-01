import type {
  CreateExtensionSkillRequest,
  ExtensionSkillRecord,
  ExtensionSkillScope,
  ExtensionSkillView,
  UpdateExtensionSkillRequest,
} from "@shiba/shared";

const BASE = "/api/v1/extensions/skills";

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    cache: "no-store",
    ...init,
  });
  const body = await response.json().catch(() => null) as T | { error?: string } | null;
  if (!response.ok) {
    const message = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
      ? body.error
      : `Skills request failed (${response.status}).`;
    throw new Error(message);
  }
  return body as T;
}

export async function fetchExtensionSkills(view: ExtensionSkillView): Promise<ExtensionSkillRecord[]> {
  const rows = await requestJson<unknown>(`${BASE}?view=${encodeURIComponent(view)}`);
  if (!Array.isArray(rows)) throw new Error("Skills could not be loaded.");
  return rows as ExtensionSkillRecord[];
}

export async function createExtensionSkill(input: CreateExtensionSkillRequest): Promise<string> {
  const body = await requestJson<{ id?: unknown }>(BASE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (typeof body?.id !== "string") throw new Error("Skill was created without an id.");
  return body.id;
}

export async function updateExtensionSkill(skillId: string, updates: Omit<UpdateExtensionSkillRequest, "skillId">): Promise<void> {
  await requestJson<{ success?: boolean }>(`${BASE}/${encodeURIComponent(skillId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(updates),
  });
}

export async function deleteExtensionSkill(skillId: string): Promise<void> {
  await requestJson<{ success?: boolean }>(`${BASE}/${encodeURIComponent(skillId)}`, { method: "DELETE" });
}

export async function moveExtensionSkill(skillId: string, to: ExtensionSkillScope): Promise<void> {
  await requestJson<{ ok?: boolean }>(`${BASE}/${encodeURIComponent(skillId)}/scope`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to }),
  });
}

export async function archiveExtensionSkill(skillId: string): Promise<void> {
  await requestJson<{ ok?: boolean }>(`${BASE}/${encodeURIComponent(skillId)}/archive`, { method: "POST" });
}

export async function restoreExtensionSkill(skillId: string): Promise<void> {
  await requestJson<{ ok?: boolean }>(`${BASE}/${encodeURIComponent(skillId)}/restore`, { method: "POST" });
}
