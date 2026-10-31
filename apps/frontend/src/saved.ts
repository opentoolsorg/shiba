/**
 * Client-side saved library: repositories and skills.
 *
 * Both are user-curated picks kept in localStorage so the task composer and
 * the Skills surface never start empty — no backend round-trip needed for
 * what's essentially a bookmark list. Seeding from run history happens in
 * app.tsx so the picker shows real repos on first use.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";

export type SavedSkillStatus = "draft" | "review" | "active" | "disabled";
export interface SavedSkill {
  id: string;
  version: number;
  status: SavedSkillStatus;
  owned: boolean;
  name: string;
  /** Optional source metadata; the backend never downloads or executes it. */
  sourceUrl?: string;
  instructions: string;
  activeVersion?: number;
  reviewedVersion?: number;
  createdAt: number;
  updatedAt: number;
}

export interface LegacySavedSkill { id: string; name: string; repoUrl?: string; notes?: string; }
export interface SavedSkillsSnapshot {
  skills: SavedSkill[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  legacySkills: LegacySavedSkill[];
}
const SERVER_SKILLS_SNAPSHOT: SavedSkillsSnapshot = { skills: [], loading: true, error: null, hasMore: false, legacySkills: [] };

const REPOS_KEY = "shiba-repos-v1";
const LEGACY_SKILLS_KEY = "shiba-skills-v1";
const IMPORTED_LEGACY_SKILLS_KEY = "shiba-skills-v1-imported-v1";
const SKILL_PAGE_SIZE = 50;

function readList<T>(key: string, isValid: (item: unknown) => item is T): T[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isValid) : [];
  } catch {
    return [];
  }
}

function writeList(key: string, items: unknown[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(items));
  } catch {
    // Storage full or blocked — the pickers still work for the session via the
    // in-memory snapshot below.
  }
  subscribers.forEach((notify) => notify());
}

const subscribers = new Set<() => void>();
function subscribe(notify: () => void): () => void {
  subscribers.add(notify);
  return () => subscribers.delete(notify);
}

// Snapshot caches so useSyncExternalStore gets a stable reference per change.
let reposCache: string[] | null = null;
let skillsCache: SavedSkill[] = [];
let skillsCursor: string | null = null;
let skillsLoadPromise: Promise<void> | null = null;
let skillsSnapshot: SavedSkillsSnapshot = { skills: skillsCache, loading: true, error: null, hasMore: false, legacySkills: [] };
let skillsSnapshotInitialized = false;

const isRepo = (item: unknown): item is string =>
  typeof item === "string" && item.length > 0;
function isSkill(item: unknown): item is SavedSkill {
  if (typeof item !== "object" || item === null) return false;
  const skill = item as Partial<SavedSkill>;
  return typeof skill.id === "string" && Number.isSafeInteger(skill.version) &&
    typeof skill.name === "string" && typeof skill.instructions === "string" &&
    (skill.status === "draft" || skill.status === "review" || skill.status === "active" || skill.status === "disabled") &&
    typeof skill.owned === "boolean";
}

function readLegacySkills(): LegacySavedSkill[] {
  return readList(LEGACY_SKILLS_KEY, (item): item is LegacySavedSkill =>
    typeof item === "object" && item !== null &&
    typeof (item as LegacySavedSkill).id === "string" &&
    typeof (item as LegacySavedSkill).name === "string" &&
    ((item as LegacySavedSkill).notes === undefined || typeof (item as LegacySavedSkill).notes === "string") &&
    ((item as LegacySavedSkill).repoUrl === undefined || typeof (item as LegacySavedSkill).repoUrl === "string"),
  );
}

function pendingLegacySkills(): LegacySavedSkill[] {
  const imported = new Set(readList(IMPORTED_LEGACY_SKILLS_KEY, isRepo));
  return readLegacySkills().filter((skill) => !imported.has(skill.id));
}

function publishSkillsSnapshot(patch: Partial<SavedSkillsSnapshot> = {}): void {
  skillsSnapshot = { ...skillsSnapshot, skills: skillsCache, legacySkills: pendingLegacySkills(), ...patch };
  skillsSnapshotInitialized = true;
  subscribers.forEach((notify) => notify());
}

export function getSavedRepos(): string[] {
  if (reposCache === null) reposCache = readList(REPOS_KEY, isRepo);
  return reposCache;
}

export function getSavedSkills(): SavedSkill[] {
  return skillsCache;
}

export function useSavedRepos(): string[] {
  return useSyncExternalStore(subscribe, getSavedRepos, () => []);
}

export function getSavedSkillsSnapshot(): SavedSkillsSnapshot {
  if (!skillsSnapshotInitialized) {
    skillsSnapshot = { ...skillsSnapshot, skills: skillsCache, legacySkills: pendingLegacySkills() };
    skillsSnapshotInitialized = true;
  }
  return skillsSnapshot;
}

export function useSavedSkills(): SavedSkillsSnapshot {
  const snapshot = useSyncExternalStore(subscribe, getSavedSkillsSnapshot, () => SERVER_SKILLS_SNAPSHOT);
  useEffect(() => { void reloadSavedSkills().catch(() => {}); }, []);
  return snapshot;
}

export function getSavedSkillsError(): string | null { return getSavedSkillsSnapshot().error; }
export function savedSkillsHaveMore(): boolean { return getSavedSkillsSnapshot().hasMore; }

export async function reloadSavedSkills(): Promise<void> {
  if (skillsLoadPromise) return skillsLoadPromise;
  publishSkillsSnapshot({ loading: true, error: null });
  skillsLoadPromise = (async () => {
    const response = await fetch(`/api/skills?limit=${SKILL_PAGE_SIZE}`, { credentials: "same-origin", cache: "no-store" });
    const body = await response.json().catch(() => null) as { skills?: unknown; nextCursor?: unknown; error?: unknown } | null;
    if (!response.ok || !body || !Array.isArray(body.skills)) {
      throw new Error(typeof body?.error === "string" ? body.error : `Skills could not be loaded (${response.status}).`);
    }
    skillsCache = body.skills.filter(isSkill);
    skillsCursor = typeof body.nextCursor === "string" ? body.nextCursor : null;
    publishSkillsSnapshot({ loading: false, error: null, hasMore: skillsCursor !== null });
  })().catch((error: unknown) => {
    publishSkillsSnapshot({ loading: false, error: error instanceof Error ? error.message : "Skills could not be loaded." });
    throw error;
  }).finally(() => { skillsLoadPromise = null; });
  return skillsLoadPromise;
}

export async function loadMoreSavedSkills(): Promise<void> {
  if (!skillsSnapshot.hasMore || !skillsCursor || skillsLoadPromise) return;
  const cursor = skillsCursor;
  publishSkillsSnapshot({ loading: true, error: null });
  skillsLoadPromise = (async () => {
    const response = await fetch(`/api/skills?limit=${SKILL_PAGE_SIZE}&cursor=${encodeURIComponent(cursor)}`, { credentials: "same-origin", cache: "no-store" });
    const body = await response.json().catch(() => null) as { skills?: unknown; nextCursor?: unknown; error?: unknown } | null;
    if (!response.ok || !body || !Array.isArray(body.skills)) {
      throw new Error(typeof body?.error === "string" ? body.error : `More skills could not be loaded (${response.status}).`);
    }
    const byId = new Map(skillsCache.map((skill) => [skill.id, skill]));
    for (const item of body.skills) if (isSkill(item)) byId.set(item.id, item);
    skillsCache = [...byId.values()];
    skillsCursor = typeof body.nextCursor === "string" ? body.nextCursor : null;
    publishSkillsSnapshot({ loading: false, error: null, hasMore: skillsCursor !== null });
  })().catch((error: unknown) => {
    publishSkillsSnapshot({ loading: false, error: error instanceof Error ? error.message : "More skills could not be loaded." });
    throw error;
  }).finally(() => { skillsLoadPromise = null; });
  return skillsLoadPromise;
}

export function useSaveRepo(): (url: string) => void {
  return useCallback((url: string) => saveRepo(url), []);
}

function invalidate(): void {
  reposCache = null;
}

export function saveRepo(url: string): void {
  const clean = url.trim();
  if (!clean) return;
  invalidate();
  const current = getSavedRepos();
  if (current.includes(clean)) return;
  reposCache = [...current, clean];
  writeList(REPOS_KEY, reposCache);
}

export function removeRepo(url: string): void {
  invalidate();
  reposCache = getSavedRepos().filter((repo) => repo !== url);
  writeList(REPOS_KEY, reposCache);
}

async function skillRequest(path: string, method: string, body?: unknown): Promise<SavedSkill> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => null) as { skill?: unknown; error?: unknown } | null;
  if (!response.ok || !payload || !isSkill(payload.skill)) {
    throw new Error(typeof payload?.error === "string" ? payload.error : `Skill update failed (${response.status}).`);
  }
  const byId = new Map(skillsCache.map((skill) => [skill.id, skill]));
  byId.set(payload.skill.id, payload.skill);
  skillsCache = [...byId.values()];
  publishSkillsSnapshot({ error: null });
  return payload.skill;
}

export function saveSkill(skill: { name: string; instructions: string; sourceUrl?: string }): Promise<SavedSkill> {
  return skillRequest("/api/skills", "POST", skill);
}

/** Import legacy browser entries as server drafts; the original local records remain untouched. */
export async function importLegacySkills(): Promise<number> {
  const candidates = getSavedSkillsSnapshot().legacySkills;
  const imported = new Set(readList(IMPORTED_LEGACY_SKILLS_KEY, isRepo));
  let count = 0;
  for (const legacy of candidates) {
    const originalSource = legacy.repoUrl?.trim() ?? "";
    let sourceUrl: string | undefined;
    if (originalSource.length <= 512) {
      try {
        const parsed = new URL(originalSource);
        if (parsed.protocol === "https:" && parsed.hostname) sourceUrl = originalSource;
      } catch { /* Preserve non-HTTPS source text in the draft instructions below. */ }
    }
    const notes = legacy.notes ?? "";
    const instructions = originalSource
      ? `${notes}${notes ? "\n\n" : ""}Legacy source: ${originalSource}`
      : notes;
    const name = legacy.name.trim().slice(0, 100) || "Imported legacy skill";
    await saveSkill({ name, instructions, ...(sourceUrl ? { sourceUrl } : {}) });
    imported.add(legacy.id);
    writeList(IMPORTED_LEGACY_SKILLS_KEY, [...imported]);
    count += 1;
    publishSkillsSnapshot();
  }
  return count;
}

export function updateSkill(id: string, expectedVersion: number, skill: { name: string; instructions: string; sourceUrl?: string }): Promise<SavedSkill> {
  return skillRequest(`/api/skills/${encodeURIComponent(id)}`, "PATCH", { ...skill, expectedVersion });
}

export function reviewSkill(id: string, version: number, reviewedInstructions: string): Promise<SavedSkill> {
  return skillRequest(`/api/skills/${encodeURIComponent(id)}/review`, "POST", { version, reviewedInstructions });
}

export function activateSkill(id: string, version: number, reviewedInstructions: string): Promise<SavedSkill> {
  return skillRequest(`/api/skills/${encodeURIComponent(id)}/activate`, "POST", { version, reviewedInstructions });
}

export async function removeSkill(id: string): Promise<void> {
  const response = await fetch(`/api/skills/${encodeURIComponent(id)}/disable`, { method: "POST", credentials: "same-origin" });
  if (!response.ok) throw new Error(`Skill could not be disabled (${response.status}).`);
  skillsCache = skillsCache.map((skill) => skill.id === id ? { ...skill, status: "disabled", activeVersion: undefined } : skill);
  publishSkillsSnapshot();
}

export async function getSkillVersions(id: string): Promise<Array<{ version: number; name: string; instructions: string; sourceUrl?: string; createdAt: number }>> {
  const response = await fetch(`/api/skills/${encodeURIComponent(id)}/versions?limit=20`, { credentials: "same-origin", cache: "no-store" });
  const body = await response.json().catch(() => null) as { versions?: unknown; error?: unknown } | null;
  if (!response.ok || !body || !Array.isArray(body.versions)) throw new Error(typeof body?.error === "string" ? body.error : `Skill history could not be loaded (${response.status}).`);
  return body.versions as Array<{ version: number; name: string; instructions: string; sourceUrl?: string; createdAt: number }>;
}

export interface LibrarySkillCard {
  slug: string;
  name: string;
  summary: string;
  tags: string[];
  version: string;
  installed: boolean;
  installedSkillId?: string;
  updateAvailable: boolean;
}

export async function fetchSkillLibrary(): Promise<LibrarySkillCard[]> {
  const response = await fetch("/api/skills/library", { credentials: "same-origin", cache: "no-store" });
  const body = await response.json().catch(() => null) as { ok?: boolean; skills?: LibrarySkillCard[]; error?: string } | null;
  if (!response.ok || !body?.ok || !Array.isArray(body.skills)) {
    throw new Error(body?.error ?? `Skill library unavailable (${response.status}).`);
  }
  return body.skills;
}

export async function installLibrarySkill(slug: string): Promise<string> {
  const response = await fetch(`/api/skills/library/${encodeURIComponent(slug)}/install`, {
    method: "POST",
    credentials: "same-origin",
  });
  const body = await response.json().catch(() => null) as { ok?: boolean; skillId?: string; error?: string } | null;
  if (!response.ok || !body?.ok || typeof body.skillId !== "string") {
    throw new Error(body?.error ?? `Install failed (${response.status}).`);
  }
  return body.skillId;
}

export async function uninstallLibrarySkill(slug: string): Promise<void> {
  const response = await fetch(`/api/skills/library/${encodeURIComponent(slug)}/install`, {
    method: "DELETE",
    credentials: "same-origin",
  });
  const body = await response.json().catch(() => null) as { ok?: boolean; error?: string } | null;
  if (!response.ok || !body?.ok) {
    throw new Error(body?.error ?? `Uninstall failed (${response.status}).`);
  }
}

// Unsent composer text per scope (session id); newest 100 kept.
const DRAFTS_KEY = "shiba-composer-drafts-v1";
type Drafts = Record<string, { text: string; updatedAt: number }>;

function readDrafts(): Drafts {
  try {
    const parsed = JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Drafts) : {};
  } catch {
    return {};
  }
}

export function readDraft(scope: string): string {
  const text = readDrafts()[scope]?.text;
  return typeof text === "string" ? text : "";
}

export function writeDraft(scope: string, text: string): void {
  try {
    const drafts = readDrafts();
    // Stored oldest-first and re-inserted on write, so the stable sort breaks same-ms ties by recency.
    delete drafts[scope];
    if (text.trim()) drafts[scope] = { text, updatedAt: Date.now() };
    const newest = Object.entries(drafts)
      .sort(([, a], [, b]) => (a?.updatedAt ?? 0) - (b?.updatedAt ?? 0))
      .slice(-100);
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(Object.fromEntries(newest)));
  } catch {
    // Storage full or blocked: the draft lives only in component state.
  }
}
