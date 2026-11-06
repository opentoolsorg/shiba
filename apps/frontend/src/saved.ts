/**
 * Client-side saved library: repositories and skills.
 *
 * Repositories and unsent drafts use private actor-namespaced browser storage.
 * Versioned skills come from the authenticated server and stay in memory.
 * The app binds its verified actor before mounting legacy consumers.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { isOnboardingDraftRef, type OnboardingDraftRef } from "./onboarding-draft";

export type SavedSkillStatus = "draft" | "review" | "active" | "disabled";
export interface SavedSkill {
  id: string;
  version: number;
  status: SavedSkillStatus;
  owned: boolean;
  name: string;
  description?: string;
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
const EMPTY_SKILLS_SNAPSHOT: SavedSkillsSnapshot = { skills: [], loading: false, error: null, hasMore: false, legacySkills: [] };
const EMPTY_REPOS: string[] = [];

// undefined exists only for older isolated consumers. Explicit null is signed out.
let libraryActor: string | null | undefined;
let actorEpoch = 0;
let actorRequests = new AbortController();
const normalizeActor = (actor: string | null | undefined) => typeof actor === "string" ? actor.trim() || null : actor;
function scopeActor(actor?: string | null): string | null | undefined {
  const requested = actor === undefined ? libraryActor : normalizeActor(actor);
  return libraryActor !== undefined && requested !== libraryActor ? null : requested;
}
function privateKey(base: string, actor?: string | null): string | null {
  const scope = scopeActor(actor);
  return scope === null ? null : scope === undefined ? base : `${base}:actor:${encodeURIComponent(scope)}`;
}
interface SavedRequestScope { actor: string | null | undefined; epoch: number; signal: AbortSignal }
function requestScope(): SavedRequestScope {
  if (libraryActor === null) throw new Error("Sign in before accessing saved skills.");
  return { actor: libraryActor, epoch: actorEpoch, signal: actorRequests.signal };
}
function assertScope(scope: SavedRequestScope): void {
  if (scope.epoch !== actorEpoch || scope.actor !== libraryActor || scope.signal.aborted) throw new DOMException("The signed-in account changed.", "AbortError");
}

/** Call synchronously with the verified identity before rendering saved-library consumers. */
export function setSavedLibraryActor(actorId: string | null): void {
  const next = normalizeActor(actorId);
  if (next === libraryActor) return;
  libraryActor = next; actorEpoch++;
  actorRequests.abort(); actorRequests = new AbortController();
  reposCache = null; reposCacheKey = null; skillsCache = []; skillsCursor = null; skillsLoadPromise = null;
  skillsSnapshot = { ...EMPTY_SKILLS_SNAPSHOT, skills: skillsCache, loading: next !== null };
  skillsSnapshotInitialized = false;
  const epoch = actorEpoch;
  // The binder runs during root rendering. Notify other subscribers after commit work.
  queueMicrotask(() => { if (epoch === actorEpoch) subscribers.forEach((notify) => { notify(); }); });
}

const REPOS_KEY = "shiba-repos-v1";
const LEGACY_SKILLS_KEY = "shiba-skills-v1";
const IMPORTED_LEGACY_SKILLS_KEY = "shiba-skills-v1-imported-v1";
const SKILL_PAGE_SIZE = 50;

function readList<T>(key: string | null, isValid: (item: unknown) => item is T): T[] {
  if (key === null) return [];
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isValid) : [];
  } catch {
    return [];
  }
}

function writeList(key: string | null, items: unknown[]): void {
  if (key === null) return;
  try {
    localStorage.setItem(key, JSON.stringify(items));
  } catch {
    // Storage full or blocked — the pickers still work for the session via the
    // in-memory snapshot below.
  }
  subscribers.forEach((notify) => { notify(); });
}

const subscribers = new Set<() => void>();
function subscribe(notify: () => void): () => void {
  subscribers.add(notify);
  return () => subscribers.delete(notify);
}

// Snapshot caches so useSyncExternalStore gets a stable reference per change.
let reposCache: string[] | null = null;
let reposCacheKey: string | null = null;
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
  return readList(privateKey(LEGACY_SKILLS_KEY), (item): item is LegacySavedSkill =>
    typeof item === "object" && item !== null &&
    typeof (item as LegacySavedSkill).id === "string" &&
    typeof (item as LegacySavedSkill).name === "string" &&
    ((item as LegacySavedSkill).notes === undefined || typeof (item as LegacySavedSkill).notes === "string") &&
    ((item as LegacySavedSkill).repoUrl === undefined || typeof (item as LegacySavedSkill).repoUrl === "string"),
  );
}

function pendingLegacySkills(): LegacySavedSkill[] {
  const imported = new Set(readList(privateKey(IMPORTED_LEGACY_SKILLS_KEY), isRepo));
  return readLegacySkills().filter((skill) => !imported.has(skill.id));
}

function publishSkillsSnapshot(patch: Partial<SavedSkillsSnapshot> = {}): void {
  skillsSnapshot = { ...skillsSnapshot, skills: skillsCache, legacySkills: pendingLegacySkills(), ...patch };
  skillsSnapshotInitialized = true;
  subscribers.forEach((notify) => { notify(); });
}

export function getSavedRepos(actorId?: string | null): string[] {
  const key = privateKey(REPOS_KEY, actorId);
  if (key === null) return EMPTY_REPOS;
  if (reposCache === null || reposCacheKey !== key) { reposCache = readList(key, isRepo); reposCacheKey = key; }
  return reposCache;
}

export function getSavedSkills(actorId?: string | null): SavedSkill[] {
  return scopeActor(actorId) === null || actorId !== undefined && normalizeActor(actorId) !== libraryActor ? EMPTY_SKILLS_SNAPSHOT.skills : skillsCache;
}

export function useSavedRepos(actorId?: string | null): string[] {
  if (actorId !== undefined) setSavedLibraryActor(actorId);
  const snapshot = useCallback(() => getSavedRepos(actorId), [actorId]);
  return useSyncExternalStore(subscribe, snapshot, () => EMPTY_REPOS);
}

export function getSavedSkillsSnapshot(actorId?: string | null): SavedSkillsSnapshot {
  if (scopeActor(actorId) === null || actorId !== undefined && normalizeActor(actorId) !== libraryActor) return EMPTY_SKILLS_SNAPSHOT;
  if (!skillsSnapshotInitialized) {
    skillsSnapshot = { ...skillsSnapshot, skills: skillsCache, legacySkills: pendingLegacySkills() };
    skillsSnapshotInitialized = true;
  }
  return skillsSnapshot;
}

export function useSavedSkills(actorId?: string | null): SavedSkillsSnapshot {
  if (actorId !== undefined) setSavedLibraryActor(actorId);
  const getSnapshot = useCallback(() => getSavedSkillsSnapshot(actorId), [actorId]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => SERVER_SKILLS_SNAPSHOT);
  const epoch = actorEpoch;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Every identity epoch must reload, including A to B to A transitions.
  useEffect(() => { if (epoch === actorEpoch && libraryActor !== null) void reloadSavedSkills().catch(() => {}); }, [epoch]);
  return snapshot;
}

export function getSavedSkillsError(): string | null { return getSavedSkillsSnapshot().error; }
export function savedSkillsHaveMore(): boolean { return getSavedSkillsSnapshot().hasMore; }

export async function reloadSavedSkills(): Promise<void> {
  if (libraryActor === null) return;
  if (skillsLoadPromise) return skillsLoadPromise;
  const scope = requestScope();
  publishSkillsSnapshot({ loading: true, error: null });
  skillsLoadPromise = (async () => {
    const response = await fetch(`/api/skills?limit=${SKILL_PAGE_SIZE}`, { credentials: "same-origin", cache: "no-store", signal: scope.signal });
    const body = await response.json().catch(() => null) as { skills?: unknown; nextCursor?: unknown; error?: unknown } | null;
    assertScope(scope);
    if (!response.ok || !body || !Array.isArray(body.skills)) {
      throw new Error(typeof body?.error === "string" ? body.error : `Skills could not be loaded (${response.status}).`);
    }
    skillsCache = body.skills.filter(isSkill);
    skillsCursor = typeof body.nextCursor === "string" ? body.nextCursor : null;
    publishSkillsSnapshot({ loading: false, error: null, hasMore: skillsCursor !== null });
  })().catch((error: unknown) => {
    assertScope(scope);
    skillsCache = []; skillsCursor = null;
    publishSkillsSnapshot({ loading: false, hasMore: false, error: error instanceof Error ? error.message : "Skills could not be loaded." });
    throw error;
  }).finally(() => { if (scope.epoch === actorEpoch) skillsLoadPromise = null; });
  return skillsLoadPromise;
}

export async function loadMoreSavedSkills(): Promise<void> {
  if (libraryActor === null) return;
  if (!skillsSnapshot.hasMore || !skillsCursor || skillsLoadPromise) return;
  const scope = requestScope();
  const cursor = skillsCursor;
  publishSkillsSnapshot({ loading: true, error: null });
  skillsLoadPromise = (async () => {
    const response = await fetch(`/api/skills?limit=${SKILL_PAGE_SIZE}&cursor=${encodeURIComponent(cursor)}`, { credentials: "same-origin", cache: "no-store", signal: scope.signal });
    const body = await response.json().catch(() => null) as { skills?: unknown; nextCursor?: unknown; error?: unknown } | null;
    assertScope(scope);
    if (!response.ok || !body || !Array.isArray(body.skills)) {
      throw new Error(typeof body?.error === "string" ? body.error : `More skills could not be loaded (${response.status}).`);
    }
    const byId = new Map(skillsCache.map((skill) => [skill.id, skill]));
    for (const item of body.skills) if (isSkill(item)) byId.set(item.id, item);
    skillsCache = [...byId.values()];
    skillsCursor = typeof body.nextCursor === "string" ? body.nextCursor : null;
    publishSkillsSnapshot({ loading: false, error: null, hasMore: skillsCursor !== null });
  })().catch((error: unknown) => {
    assertScope(scope);
    skillsCache = []; skillsCursor = null;
    publishSkillsSnapshot({ loading: false, hasMore: false, error: error instanceof Error ? error.message : "More skills could not be loaded." });
    throw error;
  }).finally(() => { if (scope.epoch === actorEpoch) skillsLoadPromise = null; });
  return skillsLoadPromise;
}

export function useSaveRepo(actorId?: string | null): (url: string) => void {
  const actor = scopeActor(actorId), epoch = actorEpoch;
  // biome-ignore lint/correctness/useExhaustiveDependencies: A captured callback expires on every identity epoch, even if the actor string later matches again.
  return useCallback((url: string) => { if (epoch === actorEpoch) saveRepo(url, actor); }, [actor, epoch]);
}

function invalidate(): void {
  reposCache = null; reposCacheKey = null;
}

export function saveRepo(url: string, actorId?: string | null): void {
  const key = privateKey(REPOS_KEY, actorId);
  if (key === null) return;
  const clean = url.trim();
  if (!clean) return;
  invalidate();
  const current = getSavedRepos(actorId);
  if (current.includes(clean)) return;
  reposCache = [...current, clean];
  reposCacheKey = key;
  writeList(key, reposCache);
}

export function removeRepo(url: string, actorId?: string | null): void {
  const key = privateKey(REPOS_KEY, actorId);
  if (key === null) return;
  invalidate();
  reposCache = getSavedRepos(actorId).filter((repo) => repo !== url);
  reposCacheKey = key;
  writeList(key, reposCache);
}

async function skillRequest(path: string, method: string, body?: unknown): Promise<SavedSkill> {
  const scope = requestScope();
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    signal: scope.signal,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => null) as { skill?: unknown; error?: unknown } | null;
  assertScope(scope);
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
  const scope = requestScope();
  const candidates = getSavedSkillsSnapshot().legacySkills;
  const markerKey = privateKey(IMPORTED_LEGACY_SKILLS_KEY);
  const imported = new Set(readList(markerKey, isRepo));
  let count = 0;
  for (const legacy of candidates) {
    assertScope(scope);
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
    assertScope(scope);
    imported.add(legacy.id);
    writeList(markerKey, [...imported]);
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
  const scope = requestScope();
  const response = await fetch(`/api/skills/${encodeURIComponent(id)}/disable`, { method: "POST", credentials: "same-origin", signal: scope.signal });
  assertScope(scope);
  if (!response.ok) throw new Error(`Skill could not be disabled (${response.status}).`);
  skillsCache = skillsCache.map((skill) => skill.id === id ? { ...skill, status: "disabled", activeVersion: undefined } : skill);
  publishSkillsSnapshot();
}

export async function getSkillVersions(id: string): Promise<Array<{ version: number; name: string; instructions: string; sourceUrl?: string; createdAt: number }>> {
  const scope = requestScope();
  const response = await fetch(`/api/skills/${encodeURIComponent(id)}/versions?limit=20`, { credentials: "same-origin", cache: "no-store", signal: scope.signal });
  const body = await response.json().catch(() => null) as { versions?: unknown; error?: unknown } | null;
  assertScope(scope);
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
  installedStatus?: SavedSkill["status"];
  installedVersion?: number;
  updateAvailable: boolean;
}

export async function fetchSkillLibrary(): Promise<LibrarySkillCard[]> {
  const scope = requestScope();
  const response = await fetch("/api/skills/library", { credentials: "same-origin", cache: "no-store", signal: scope.signal });
  const body = await response.json().catch(() => null) as { ok?: boolean; skills?: LibrarySkillCard[]; error?: string } | null;
  assertScope(scope);
  if (!response.ok || !body?.ok || !Array.isArray(body.skills)) {
    throw new Error(body?.error ?? `Skill library unavailable (${response.status}).`);
  }
  return body.skills;
}

export async function installLibrarySkill(slug: string): Promise<string> {
  const scope = requestScope();
  const response = await fetch(`/api/skills/library/${encodeURIComponent(slug)}/install`, {
    method: "POST",
    credentials: "same-origin",
    signal: scope.signal,
  });
  const body = await response.json().catch(() => null) as { ok?: boolean; skillId?: string; error?: string } | null;
  assertScope(scope);
  if (!response.ok || !body?.ok || typeof body.skillId !== "string") {
    throw new Error(body?.error ?? `Install failed (${response.status}).`);
  }
  return body.skillId;
}

export async function uninstallLibrarySkill(slug: string): Promise<void> {
  const scope = requestScope();
  const response = await fetch(`/api/skills/library/${encodeURIComponent(slug)}/install`, {
    method: "DELETE",
    credentials: "same-origin",
    signal: scope.signal,
  });
  const body = await response.json().catch(() => null) as { ok?: boolean; error?: string } | null;
  assertScope(scope);
  if (!response.ok || !body?.ok) {
    throw new Error(body?.error ?? `Uninstall failed (${response.status}).`);
  }
}

// Unsent composer text per scope (session id); newest 100 kept.
const DRAFTS_KEY = "shiba-composer-drafts-v1";
export function composerDraftScope(owner: string, sessionId: string): string {
  return JSON.stringify([owner, sessionId]);
}
type Drafts = Record<string, { text: string; updatedAt: number; onboardingDraft?: OnboardingDraftRef }>;

function readDrafts(actorId?: string | null): Drafts {
  const key = privateKey(DRAFTS_KEY, actorId);
  if (key === null) return {};
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Drafts) : {};
  } catch {
    return {};
  }
}

export function readDraft(scope: string, actorId?: string | null): string {
  const text = readDrafts(actorId)[scope]?.text;
  return typeof text === "string" ? text : "";
}

export function readDraftReference(scope: string, actorId?: string | null): OnboardingDraftRef | null {
  const ref = readDrafts(actorId)[scope]?.onboardingDraft;
  return isOnboardingDraftRef(ref) ? { draftTaskId: ref.draftTaskId, version: ref.version } : null;
}

export function writeDraft(scope: string, text: string, onboardingDraft?: OnboardingDraftRef | null, actorId?: string | null): void {
  const key = privateKey(DRAFTS_KEY, actorId);
  if (key === null) return;
  // Composer scopes contain their verified owner; stale callbacks cannot save it for a new actor.
  if (libraryActor !== undefined) {
    try { const ownerScope: unknown = JSON.parse(scope); if (Array.isArray(ownerScope) && ownerScope[0] !== libraryActor) return; }
    catch { /* Onboarding uses an opaque, actor-namespaced scope. */ }
  }
  try {
    const drafts = readDrafts(actorId);
    // Stored oldest-first and re-inserted on write, so the stable sort breaks same-ms ties by recency.
    delete drafts[scope];
    if (text.trim()) drafts[scope] = { text, updatedAt: Date.now(), ...(isOnboardingDraftRef(onboardingDraft) ? { onboardingDraft } : {}) };
    const newest = Object.entries(drafts)
      .sort(([, a], [, b]) => (a?.updatedAt ?? 0) - (b?.updatedAt ?? 0))
      .slice(-100);
    localStorage.setItem(key, JSON.stringify(Object.fromEntries(newest)));
  } catch {
    // Storage full or blocked: the draft lives only in component state.
  }
}
