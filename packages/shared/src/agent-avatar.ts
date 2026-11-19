/**
 * Bot avatars: a curated set of parameterised visor-mascot variants plus the
 * brand coat palette. Nothing here is an image file — a variant names the parts
 * `AgentMascot` already draws, so one renderer serves the gallery, the profile
 * and every surface a bot appears on.
 */
import type { AgentMascotAcc, AgentMascotEyes, AgentMascotLook, AgentMascotShape } from "./agent-mascot.js";

export interface AgentAvatarVariant {
  id: string;
  label: string;
  shape: AgentMascotShape;
  eyes: AgentMascotEyes;
  acc: AgentMascotAcc;
}

/**
 * Twenty silhouettes across the construction: upright ears on the pointed head,
 * floppy silhouettes on cloud and bean, earless round, hex, squircle, pebble,
 * egg and capsule heads, each with its own face and muzzle glyph.
 */
export const AGENT_AVATAR_VARIANTS: readonly AgentAvatarVariant[] = [
  { id: "classic", label: "Classic", shape: "pointed", eyes: "happy", acc: "none" },
  { id: "coder", label: "Coder", shape: "pointed", eyes: "code", acc: "wrench" },
  { id: "reviewer", label: "Reviewer", shape: "pointed", eyes: "squint", acc: "check" },
  { id: "writer", label: "Writer", shape: "pointed", eyes: "pill", acc: "pen" },
  { id: "announcer", label: "Announcer", shape: "pointed", eyes: "big", acc: "megaphone" },
  { id: "napper", label: "Napper", shape: "pointed", eyes: "sleepy", acc: "coffee" },
  { id: "chum", label: "Flop-ear chum", shape: "cloud", eyes: "happy", acc: "none" },
  { id: "scout", label: "Scout", shape: "cloud", eyes: "surprised", acc: "loupe" },
  { id: "messenger", label: "Messenger", shape: "cloud", eyes: "wink", acc: "megaphone" },
  { id: "buddy", label: "Buddy", shape: "bean", eyes: "big", acc: "headset" },
  { id: "notetaker", label: "Note-taker", shape: "bean", eyes: "pill", acc: "clipboard" },
  { id: "navigator", label: "Navigator", shape: "bean", eyes: "star", acc: "compass" },
  { id: "helper", label: "Helper", shape: "round", eyes: "heart", acc: "headset" },
  { id: "runner", label: "Runner", shape: "round", eyes: "code", acc: "none" },
  { id: "analyst", label: "Analyst", shape: "hex", eyes: "squint", acc: "chart" },
  { id: "archivist", label: "Archivist", shape: "hex", eyes: "surprised", acc: "list" },
  { id: "lead", label: "Lead", shape: "squircle", eyes: "star", acc: "clipboard" },
  { id: "closer", label: "Closer", shape: "squircle", eyes: "happy", acc: "bag" },
  { id: "drifter", label: "Drifter", shape: "pebble", eyes: "wink", acc: "none" },
  { id: "hatchling", label: "Hatchling", shape: "egg", eyes: "big", acc: "pen" },
  { id: "capsule", label: "Capsule", shape: "capsule", eyes: "sleepy", acc: "coffee" },
] as const;

export type AgentAvatarVariantId = (typeof AGENT_AVATAR_VARIANTS)[number]["id"];

/** Twelve coats from the brand palette: creams, browns, moss, slate and navy. */
export const AGENT_AVATAR_COATS = [
  "#f4e2c4", "#c4a574", "#ddc9a3", "#a65a3a", "#6b4a32", "#6e8b6a",
  "#6e7ca8", "#2c3e6b", "#2a3138", "#6a6f63", "#9a948c", "#f7f1e6",
] as const;

export type AgentAvatarCoat = (typeof AGENT_AVATAR_COATS)[number];

/** Uploaded portraits are referenced by id, never by URL or bytes. */
export const AGENT_AVATAR_FILE_ID = /^file_[A-Za-z0-9]{4,64}$/;

export interface AgentAvatarVariantChoice {
  kind: "variant";
  variant: AgentAvatarVariantId;
  color: AgentAvatarCoat;
}

export interface AgentAvatarUploadChoice {
  kind: "upload";
  fileId: string;
}

export type AgentAvatarChoice = AgentAvatarVariantChoice | AgentAvatarUploadChoice;

const VARIANTS_BY_ID = new Map(AGENT_AVATAR_VARIANTS.map((variant) => [variant.id, variant]));
const COATS = new Set<string>(AGENT_AVATAR_COATS);

export function avatarVariant(id: string | undefined): AgentAvatarVariant | undefined {
  return id ? VARIANTS_BY_ID.get(id) : undefined;
}

/** A coat is one of the palette values; anything else is refused rather than coerced. */
export function avatarCoat(color: string | undefined): AgentAvatarCoat | undefined {
  if (!color) return undefined;
  const value = color.trim().toLowerCase();
  return COATS.has(value) ? value as AgentAvatarCoat : undefined;
}

/** Coerce a stored avatar, dropping parts that are not on the allowed lists. */
export function normalizeAgentAvatar(input: unknown): AgentAvatarChoice | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Record<string, unknown>;
  if (raw.kind === "upload") {
    const fileId = typeof raw.fileId === "string" ? raw.fileId.trim() : "";
    return AGENT_AVATAR_FILE_ID.test(fileId) ? { kind: "upload", fileId } : undefined;
  }
  const variant = avatarVariant(typeof raw.variant === "string" ? raw.variant : undefined);
  const color = avatarCoat(typeof raw.color === "string" ? raw.color : undefined);
  if (raw.kind !== "variant" || !variant || !color) return undefined;
  return { kind: "variant", variant: variant.id, color };
}

/** The look a variant draws at a coat: same parts as a role mark, this coat. */
export function avatarLook(choice: AgentAvatarChoice | undefined): AgentMascotLook | undefined {
  if (!choice || choice.kind !== "variant") return undefined;
  const variant = avatarVariant(choice.variant);
  if (!variant) return undefined;
  return { shape: variant.shape, color: choice.color, eyes: variant.eyes, acc: variant.acc };
}

/** Next variant and coat for Shuffle; stable for a given seed so a re-render cannot re-shuffle. */
export function shuffledAvatar(seed: string, current?: AgentAvatarChoice): AgentAvatarChoice {
  let value = 2166136261;
  for (const character of seed) value = Math.imul(value ^ character.charCodeAt(0), 16777619) >>> 0;
  const variants = AGENT_AVATAR_VARIANTS.filter((variant) => !(current?.kind === "variant" && current.variant === variant.id));
  const coats = AGENT_AVATAR_COATS.filter((coat) => !(current?.kind === "variant" && current.color === coat));
  const variant = variants[value % variants.length] ?? AGENT_AVATAR_VARIANTS[0]!;
  const color = coats[(value >>> 8) % coats.length] ?? AGENT_AVATAR_COATS[0];
  return { kind: "variant", variant: variant.id, color };
}
