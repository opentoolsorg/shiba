/**
 * Original Shiba visor-mascot look. Part choices travel with a custom agent.
 * Drawing lives in the dashboard; this module only names and normalizes the parts.
 */

export const AGENT_MASCOT_SHAPES = [
  "round", "bean", "pointed", "cloud", "hex", "squircle", "pebble", "egg", "capsule",
] as const;
export type AgentMascotShape = (typeof AGENT_MASCOT_SHAPES)[number];

export const AGENT_MASCOT_EYES = [
  "pill", "big", "happy", "wink", "surprised", "squint", "sleepy", "heart", "star", "code",
] as const;
export type AgentMascotEyes = (typeof AGENT_MASCOT_EYES)[number];

/** Resting faces used for shuffle and automatic assignment — friendly by default. */
export const AGENT_MASCOT_FRIENDLY_EYES = [
  "pill", "big", "happy", "wink", "surprised", "heart", "star",
] as const satisfies readonly AgentMascotEyes[];

export const AGENT_MASCOT_ACCS = [
  "none", "pen", "wrench", "coffee", "loupe", "megaphone", "clipboard", "compass", "headset", "chart",
] as const;
export type AgentMascotAcc = (typeof AGENT_MASCOT_ACCS)[number];

/** Natural creams and browns, plus a few dyed coats. Stored as hex. */
export const AGENT_MASCOT_FURS = [
  { id: "cream", label: "Cream", hex: "#f4e2c4" },
  { id: "sesame", label: "Sesame", hex: "#c4a574" },
  { id: "red", label: "Red", hex: "#a65a3a" },
  { id: "cocoa", label: "Cocoa", hex: "#6b4a32" },
  { id: "white", label: "White", hex: "#f7f1e6" },
  { id: "black", label: "Black", hex: "#3a342e" },
  { id: "coral", label: "Coral", hex: "#e07a5f" },
  { id: "moss", label: "Moss", hex: "#6e8b6a" },
  { id: "dusk", label: "Dusk", hex: "#6e7ca8" },
  { id: "ink", label: "Ink", hex: "#2a3138" },
  { id: "sky", label: "Sky", hex: "#7ec8e3" },
  { id: "navy", label: "Navy", hex: "#2c3e6b" },
  { id: "pink", label: "Pink", hex: "#e8a0bf" },
  { id: "wine", label: "Wine", hex: "#7a3b52" },
  { id: "sand", label: "Sand", hex: "#ddc9a3" },
  { id: "gray", label: "Gray", hex: "#9a948c" },
  { id: "lime", label: "Lime", hex: "#b5d86a" },
  { id: "indigo", label: "Indigo", hex: "#5c6bc0" },
] as const;
export type AgentMascotFurId = (typeof AGENT_MASCOT_FURS)[number]["id"];

export const CUSTOM_AGENT_MASCOT_PRESETS = ["hero", "climbing", "riding", "sleeping", "sunglasses"] as const;
export type CustomAgentMascotPreset = (typeof CUSTOM_AGENT_MASCOT_PRESETS)[number];

export interface AgentMascotLook {
  shape: AgentMascotShape;
  /** Fur color as `#rrggbb`. */
  color: string;
  eyes: AgentMascotEyes;
  acc: AgentMascotAcc;
}

/** One-click avatar recipes in the agent editor (OpenBot-style starters). */
export const AGENT_MASCOT_STARTER_LOOKS: ReadonlyArray<{ id: string; label: string; look: AgentMascotLook }> = [
  { id: "classic", label: "Classic", look: { shape: "pointed", color: "#c4a574", eyes: "happy", acc: "none" } },
  { id: "coder", label: "Coder", look: { shape: "hex", color: "#2a3138", eyes: "code", acc: "wrench" } },
  { id: "cheer", label: "Cheerful", look: { shape: "round", color: "#e07a5f", eyes: "big", acc: "none" } },
  { id: "researcher", label: "Scout", look: { shape: "cloud", color: "#6e7ca8", eyes: "surprised", acc: "loupe" } },
  { id: "host", label: "Host", look: { shape: "bean", color: "#f4e2c4", eyes: "wink", acc: "coffee" } },
  { id: "lead", label: "Lead", look: { shape: "squircle", color: "#6e8b6a", eyes: "star", acc: "clipboard" } },
  { id: "pebble-sky", label: "Sky", look: { shape: "pebble", color: "#7ec8e3", eyes: "pill", acc: "none" } },
  { id: "egg-lime", label: "Bright", look: { shape: "egg", color: "#b5d86a", eyes: "heart", acc: "pen" } },
];

const HEX = /^#[0-9a-f]{6}$/;

const TEMPLATE_LOOKS: Record<string, AgentMascotLook> = {
  "coding-coworker": { shape: "pointed", color: "#c4a574", eyes: "happy", acc: "none" },
  "slack-digester": { shape: "round", color: "#f7f1e6", eyes: "sleepy", acc: "coffee" },
  "pr-reviewer": { shape: "hex", color: "#2a3138", eyes: "squint", acc: "loupe" },
  "standup-summarizer": { shape: "bean", color: "#6b4a32", eyes: "sleepy", acc: "clipboard" },
  "product-spec-writer": { shape: "squircle", color: "#a65a3a", eyes: "squint", acc: "none" },
  "prototype-builder": { shape: "cloud", color: "#f4e2c4", eyes: "big", acc: "none" },
  "competitor-watch": { shape: "hex", color: "#6e7ca8", eyes: "squint", acc: "megaphone" },
  "support-triage": { shape: "pointed", color: "#6e8b6a", eyes: "happy", acc: "headset" },
  "slack-coworker": { shape: "round", color: "#c4a574", eyes: "wink", acc: "megaphone" },
  "roster-manager": { shape: "cloud", color: "#6b4a32", eyes: "pill", acc: "clipboard" },
  "reason-engineering-lead": { shape: "hex", color: "#a65a3a", eyes: "code", acc: "compass" },
};

const ROLE_LOOKS: Record<string, AgentMascotLook> = {
  engineering: { shape: "pointed", color: "#6b4a32", eyes: "code", acc: "wrench" },
  marketing: { shape: "cloud", color: "#e07a5f", eyes: "big", acc: "megaphone" },
  sales: { shape: "bean", color: "#6e7ca8", eyes: "happy", acc: "megaphone" },
  product: { shape: "squircle", color: "#f4e2c4", eyes: "pill", acc: "pen" },
  design: { shape: "cloud", color: "#f7f1e6", eyes: "star", acc: "pen" },
  research: { shape: "hex", color: "#2a3138", eyes: "surprised", acc: "loupe" },
  operations: { shape: "round", color: "#c4a574", eyes: "sleepy", acc: "coffee" },
  qa: { shape: "pointed", color: "#a65a3a", eyes: "squint", acc: "loupe" },
  gtm: { shape: "bean", color: "#6e8b6a", eyes: "wink", acc: "chart" },
  hr: { shape: "squircle", color: "#f4e2c4", eyes: "heart", acc: "clipboard" },
  finance: { shape: "hex", color: "#3a342e", eyes: "squint", acc: "chart" },
};

/** Sticker presets stay recognizable as unique visor looks. */
export const MASCOT_PRESET_LOOKS: Record<CustomAgentMascotPreset, AgentMascotLook> = {
  hero: TEMPLATE_LOOKS["coding-coworker"]!,
  climbing: TEMPLATE_LOOKS["product-spec-writer"]!,
  riding: TEMPLATE_LOOKS["prototype-builder"]!,
  sleeping: TEMPLATE_LOOKS["slack-digester"]!,
  sunglasses: TEMPLATE_LOOKS["pr-reviewer"]!,
};

const NAMED_LOOKS: Record<string, AgentMascotLook> = {
  ...TEMPLATE_LOOKS,
  shiba: MASCOT_PRESET_LOOKS.hero,
  "workspace-chief": MASCOT_PRESET_LOOKS.hero,
};

function oneOf<T extends string>(values: readonly T[], input: unknown): T | undefined {
  return typeof input === "string" && (values as readonly string[]).includes(input) ? input as T : undefined;
}

export function normalizeMascotColor(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const value = input.trim().toLowerCase();
  const named = AGENT_MASCOT_FURS.find((fur) => fur.id === value || fur.hex === value);
  if (named) return named.hex;
  return HEX.test(value) ? value : undefined;
}

/** Coerce a stored look. Invalid parts fall back; a non-object does not invent a face. */
export function normalizeAgentMascotLook(input: unknown): AgentMascotLook | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Record<string, unknown>;
  const shape = oneOf(AGENT_MASCOT_SHAPES, raw.shape);
  const eyes = oneOf(AGENT_MASCOT_EYES, raw.eyes);
  const acc = oneOf(AGENT_MASCOT_ACCS, raw.acc);
  const color = normalizeMascotColor(raw.color);
  if (!shape && !eyes && !acc && !color) return undefined;
  return {
    shape: shape ?? "round",
    color: color ?? AGENT_MASCOT_FURS[0].hex,
    eyes: eyes ?? "pill",
    acc: acc ?? "none",
  };
}

function mix(seed: string, salt: number): number {
  let value = salt >>> 0;
  for (let index = 0; index < seed.length; index += 1) {
    value = (Math.imul(value, 33) + seed.charCodeAt(index) + salt) >>> 0;
  }
  return value;
}

function hashLook(id: string): AgentMascotLook {
  const fur = AGENT_MASCOT_FURS[mix(id, 1) % AGENT_MASCOT_FURS.length]!;
  return {
    shape: AGENT_MASCOT_SHAPES[mix(id, 3) % AGENT_MASCOT_SHAPES.length]!,
    color: fur.hex,
    eyes: AGENT_MASCOT_FRIENDLY_EYES[mix(id, 5) % AGENT_MASCOT_FRIENDLY_EYES.length]!,
    acc: AGENT_MASCOT_ACCS[mix(id, 9) % AGENT_MASCOT_ACCS.length]!,
  };
}

/** Template id wins, then employee role, then a stable hash so strangers do not share a face. */
export function defaultLookFor(id: string, role?: string): AgentMascotLook {
  const named = NAMED_LOOKS[id];
  if (named) return named;
  if (role && role !== "custom" && ROLE_LOOKS[role]) return ROLE_LOOKS[role];
  return hashLook(id);
}

export function mascotLookForPreset(preset: CustomAgentMascotPreset): AgentMascotLook {
  return MASCOT_PRESET_LOOKS[preset];
}

export function resolveAgentMascotLook(input: {
  id: string;
  role?: string;
  fallbackId?: string;
  preset?: CustomAgentMascotPreset | null;
  look?: unknown;
}): AgentMascotLook {
  if (input.look && typeof input.look === "object") {
    const raw = input.look as Record<string, unknown>;
    const shape = oneOf(AGENT_MASCOT_SHAPES, raw.shape);
    const color = normalizeMascotColor(raw.color);
    const eyes = oneOf(AGENT_MASCOT_EYES, raw.eyes);
    const acc = oneOf(AGENT_MASCOT_ACCS, raw.acc);
    if (shape && color && eyes && acc) return { shape, color, eyes, acc };
  }
  if (input.preset && (CUSTOM_AGENT_MASCOT_PRESETS as readonly string[]).includes(input.preset)) {
    return MASCOT_PRESET_LOOKS[input.preset];
  }
  if (NAMED_LOOKS[input.id]) return NAMED_LOOKS[input.id]!;
  if (input.role && input.role !== "custom" && ROLE_LOOKS[input.role]) return ROLE_LOOKS[input.role]!;
  return hashLook(input.fallbackId ?? input.id);
}

export function formLook(shape: string, color: string, eyes: string, acc: string): AgentMascotLook | undefined {
  if (!shape && !color && !eyes && !acc) return undefined;
  return normalizeAgentMascotLook({ shape, color, eyes, acc });
}

/** Random friendly avatar; optional seed keeps choices stable for a given string. */
export function randomMascotLook(seed?: string): AgentMascotLook {
  const pick = <T,>(items: readonly T[], salt: number) => (
    seed ? items[mix(seed, salt) % items.length]! : items[Math.floor(Math.random() * items.length)]!
  );
  return {
    shape: pick(AGENT_MASCOT_SHAPES, 3),
    color: pick(AGENT_MASCOT_FURS.map((fur) => fur.hex), 1),
    eyes: pick(AGENT_MASCOT_FRIENDLY_EYES, 5),
    acc: pick(AGENT_MASCOT_ACCS, 9),
  };
}
