/**
 * Den orchestrator state (Phase 2b). One CodingOrchestrator DO per
 * `den:{userId}:{slug}` — Shiba's long-lived pack coordinator (not a new DO class).
 */
import type { RunStatus } from "./runs.js";

export const DEN_NAME_PREFIX = "den:";
/** @deprecated Use {@link DEN_NAME_PREFIX}. Accepted when parsing legacy agent names. */
export const CAPTAIN_NAME_PREFIX = "captain:";

const LEGACY_PREFIXES = [DEN_NAME_PREFIX, CAPTAIN_NAME_PREFIX] as const;

export interface DenPackEntry {
  runId: string;
  path?: string;
  task: string;
  repoUrl: string;
  status: RunStatus;
  updatedAt: number;
  pullUrl?: string;
}

/** @deprecated Use {@link DenPackEntry}. */
export type CaptainCrewEntry = DenPackEntry;

/** Operator-facing rollup of what needs attention on this den. */
export interface DenDigest {
  updatedAt: number;
  pendingApprovals: number;
  activeRuns: number;
  completedRuns: number;
  needsYou: string[];
}

/** @deprecated Use {@link DenDigest}. */
export type CaptainDigest = DenDigest;

export interface DenDriveMeta {
  path: string;
  size: number;
  updatedAt: number;
}

/** @deprecated Use {@link DenDriveMeta}. */
export type CaptainDriveMeta = DenDriveMeta;

/** Sanitize a den slug for DO naming (dns-safe segment). */
export function sanitizeDenSlug(raw: string): string | null {
  const slug = raw.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug || slug.length > 48) return null;
  return slug;
}

/** @deprecated Use {@link sanitizeDenSlug}. */
export const sanitizeCaptainSlug = sanitizeDenSlug;

export function buildDenAgentName(userId: string, slug: string): string {
  const cleanUser = userId.trim();
  const cleanSlug = sanitizeDenSlug(slug);
  if (!cleanUser || !cleanSlug) {
    throw new Error("Invalid den name.");
  }
  return `${DEN_NAME_PREFIX}${cleanUser}:${cleanSlug}`;
}

/** @deprecated Use {@link buildDenAgentName}. */
export const buildCaptainAgentName = buildDenAgentName;

export function parseDenAgentName(agentName: string): { userId: string; slug: string } | null {
  const prefix = LEGACY_PREFIXES.find((p) => agentName.startsWith(p));
  if (!prefix) return null;
  const rest = agentName.slice(prefix.length);
  const colon = rest.indexOf(":");
  if (colon <= 0 || colon === rest.length - 1) return null;
  const userId = rest.slice(0, colon);
  const slug = rest.slice(colon + 1);
  if (!userId.trim() || sanitizeDenSlug(slug) !== slug) return null;
  return { userId, slug };
}

/** @deprecated Use {@link parseDenAgentName}. */
export const parseCaptainAgentName = parseDenAgentName;

export function driveObjectKey(denAgentName: string, path: string): string {
  const normalized = path.replace(/^\/+/, "").replace(/\.\./g, "");
  return `den/${denAgentName}/drive/${normalized}`;
}

/** Legacy R2 prefix for drive files written before the den rename. */
export function legacyCaptainDriveObjectKey(denAgentName: string, path: string): string {
  const normalized = path.replace(/^\/+/, "").replace(/\.\./g, "");
  return `captain/${denAgentName}/drive/${normalized}`;
}

/** Resolve den id fields from stored run/approval payloads (denId preferred). */
export function resolveDenId(fields: { denId?: string; captainId?: string }): string | undefined {
  return fields.denId ?? fields.captainId;
}

/** Emit both denId and captainId for API responses during the compatibility window. */
export function denIdWireFields(
  denId: string | undefined,
): { denId?: string; captainId?: string } {
  if (denId === undefined) return {};
  return { denId, captainId: denId };
}
