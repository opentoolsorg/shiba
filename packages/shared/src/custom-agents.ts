/**
 * Org-scoped custom agent definitions (dashboard + /api/v1).
 * Validation at the Worker boundary uses Effect Schema in apps/backend.
 */

export const CUSTOM_AGENT_APPROVAL_POLICIES = ["standard", "auto_approve"] as const;
export type CustomAgentApprovalPolicy = (typeof CUSTOM_AGENT_APPROVAL_POLICIES)[number];

export const CUSTOM_AGENT_SANDBOX_PROVIDERS = [
  "cloudflare",
  "docker-local",
  "computesdk",
  "e2b",
] as const;
export type CustomAgentSandboxProvider = (typeof CUSTOM_AGENT_SANDBOX_PROVIDERS)[number];

/** Optional template provenance; these labels do not grant tools or connections. */
export const CUSTOM_AGENT_ROLE_TEMPLATE_IDS = [
  "engineering", "marketing", "sales", "product", "design", "research", "operations", "qa",
  "gtm", "hr", "finance",
] as const;
export type CustomAgentRoleTemplateId = (typeof CUSTOM_AGENT_ROLE_TEMPLATE_IDS)[number];

import type { AgentMascotLook, CustomAgentMascotPreset } from "./agent-mascot.js";
import type { AgentAvatarChoice } from "./agent-avatar.js";

export {
  AGENT_AVATAR_COATS,
  AGENT_AVATAR_FILE_ID,
  AGENT_AVATAR_VARIANTS,
  avatarCoat,
  avatarLook,
  avatarVariant,
  normalizeAgentAvatar,
  shuffledAvatar,
  type AgentAvatarChoice,
  type AgentAvatarCoat,
  type AgentAvatarUploadChoice,
  type AgentAvatarVariant,
  type AgentAvatarVariantChoice,
  type AgentAvatarVariantId,
} from "./agent-avatar.js";

export {
  AGENT_MASCOT_ACCS,
  AGENT_MASCOT_BRAND_FURS,
  AGENT_MASCOT_EYES,
  AGENT_MASCOT_ROLE_LOOKS,
  AGENT_MASCOT_FRIENDLY_EYES,
  AGENT_MASCOT_FURS,
  AGENT_MASCOT_SHAPES,
  AGENT_MASCOT_STARTER_LOOKS,
  CUSTOM_AGENT_MASCOT_PRESETS,
  defaultLookFor,
  formLook,
  mascotLookForPreset,
  normalizeAgentMascotLook,
  normalizeMascotColor,
  randomMascotLook,
  resolveAgentMascotLook,
} from "./agent-mascot.js";
export type {
  AgentMascotAcc,
  AgentMascotEyes,
  AgentMascotFurId,
  AgentMascotLook,
  AgentMascotShape,
  CustomAgentMascotPreset,
} from "./agent-mascot.js";

/** Versioned config blob stored in D1 (JSON). */
export interface CustomAgentConfig {
  name: string;
  emoji?: string;
  mascotPreset?: CustomAgentMascotPreset;
  /** Visor-mascot parts. When set, this wins over mascotPreset. */
  look?: AgentMascotLook;
  /** The chosen editable role template, retained when the bot is renamed. */
  roleTemplateId?: CustomAgentRoleTemplateId;
  instructions: string;
  /**
   * A chosen avatar: a gallery variant at a brand coat, or an uploaded portrait
   * by file id. Absent means the role mark the bot is seeded with still applies.
   */
  avatar?: AgentAvatarChoice;
  /** Optional workspace outputs frozen into each approval. */
  expectedDeliverables?: readonly string[];
  /**
   * Workspace knowledge file ids this bot's Library links to. Ids only, never a
   * copy of the bytes: opening one re-runs the file's own access check, so a
   * link cannot widen who may read it.
   */
  libraryFileIds?: readonly string[];
  harness: string;
  codingModel?: string;
  connectionId?: string;
  sandboxProvider?: CustomAgentSandboxProvider;
  defaultRepoUrl?: string;
  approvalPolicy?: CustomAgentApprovalPolicy;
  /** MCP tool scope ids the agent may use (empty = deployment default). */
  toolScopes?: readonly string[];
}

export interface CustomAgentRecord {
  id: string;
  orgId: string;
  slug: string;
  version: number;
  config: CustomAgentConfig;
  createdAt: number;
  updatedAt: number;
  /** Archived profiles retain history but cannot start new execution. */
  archivedAt?: number;
  deletedAt?: number;
}

export interface CustomAgentVersionRow {
  agentId: string;
  orgId: string;
  version: number;
  config: CustomAgentConfig;
  savedAt: number;
}

/** A bot's Library links to at most this many knowledge files. */
export const MAX_BOT_LIBRARY_FILES = 8;

/** Knowledge file ids are minted server-side as `file_<hex>`; a link may only name one of those. */
export const BOT_LIBRARY_FILE_ID = /^file_[A-Za-z0-9]{4,64}$/;

/**
 * Reads the linked file ids from a stored config, dropping anything that is not
 * an id. The stored list is a claim about intent, never about access: each id is
 * resolved through the file route's own permission check before it is shown.
 */
export function botLibraryFileIds(config: Pick<CustomAgentConfig, "libraryFileIds"> | undefined): string[] {
  const raw = config?.libraryFileIds ?? [];
  const ids = raw.filter((id): id is string => typeof id === "string" && BOT_LIBRARY_FILE_ID.test(id));
  return [...new Set(ids)].slice(0, MAX_BOT_LIBRARY_FILES);
}

export function sanitizeCustomAgentSlug(raw: string): string | null {
  const slug = raw.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug || slug.length > 48) return null;
  return slug;
}
