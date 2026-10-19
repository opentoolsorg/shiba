/**
 * Captain orchestrator state (Phase 2b). One CodingOrchestrator DO per
 * `captain:{userId}:{slug}` — not a new DO class.
 */
import type { RunStatus } from "./runs.js";

export const CAPTAIN_NAME_PREFIX = "captain:";

export interface CaptainCrewEntry {
  runId: string;
  path?: string;
  task: string;
  repoUrl: string;
  status: RunStatus;
  updatedAt: number;
  pullUrl?: string;
}

/** Operator-facing rollup of what needs attention on this captain. */
export interface CaptainDigest {
  updatedAt: number;
  pendingApprovals: number;
  activeRuns: number;
  completedRuns: number;
  needsYou: string[];
}

export interface CaptainDriveMeta {
  path: string;
  size: number;
  updatedAt: number;
}

/** Sanitize a captain slug for DO naming (dns-safe segment). */
export function sanitizeCaptainSlug(raw: string): string | null {
  const slug = raw.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug || slug.length > 48) return null;
  return slug;
}

export function buildCaptainAgentName(userId: string, slug: string): string {
  const cleanUser = userId.trim();
  const cleanSlug = sanitizeCaptainSlug(slug);
  if (!cleanUser || !cleanSlug) {
    throw new Error("Invalid captain name.");
  }
  return `${CAPTAIN_NAME_PREFIX}${cleanUser}:${cleanSlug}`;
}

export function parseCaptainAgentName(
  agentName: string,
): { userId: string; slug: string } | null {
  if (!agentName.startsWith(CAPTAIN_NAME_PREFIX)) return null;
  const rest = agentName.slice(CAPTAIN_NAME_PREFIX.length);
  const colon = rest.indexOf(":");
  if (colon <= 0 || colon === rest.length - 1) return null;
  const userId = rest.slice(0, colon);
  const slug = rest.slice(colon + 1);
  if (!userId.trim() || sanitizeCaptainSlug(slug) !== slug) return null;
  return { userId, slug };
}

export function driveObjectKey(captainAgentName: string, path: string): string {
  const normalized = path.replace(/^\/+/, "").replace(/\.\./g, "");
  return `captain/${captainAgentName}/drive/${normalized}`;
}
