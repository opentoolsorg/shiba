import { z } from "zod";
import { CUSTOM_AGENT_ROLE_TEMPLATE_IDS } from "./custom-agents.js";
import { expectedDeliverablesSchema } from "./deliverables.js";
import { redactSecrets } from "./security.js";

export const MAX_EMPLOYEE_BUNDLE_BYTES = 200_000;
export const EMPLOYEE_BUNDLE_FORMAT = "shiba.employee-bundle.v1" as const;

const text = (max: number) => z.string().trim().min(1).max(max).refine(
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Rejects control bytes in untrusted identity or portable text input.
  (value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value), "Unsupported control characters.",
);
const source = z.object({
  kind: z.enum(["catalog", "employee", "managed-skill"]),
  id: text(100),
  revision: text(64),
}).strict();

/** Portable instructions and setup requirements, never authority or executable extensions. */
export const EmployeeBundleSchema = z.object({
  format: z.literal(EMPLOYEE_BUNDLE_FORMAT),
  audience: z.literal("personal"),
  profile: z.object({
    name: text(120),
    instructions: text(32_000),
    harness: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    codingModel: text(200).optional(),
    emoji: text(16).optional(),
    roleTemplateId: z.enum(CUSTOM_AGENT_ROLE_TEMPLATE_IDS).optional(),
    expectedDeliverables: expectedDeliverablesSchema.default([]),
    provenance: source.optional(),
  }).strict(),
  skills: z.array(z.object({
    name: text(100),
    instructions: text(16_000),
    provenance: source.optional(),
  }).strict()).max(5).default([]),
  requirements: z.array(z.object({
    kind: z.enum(["app", "mcp", "skill"]),
    name: text(100),
    description: text(500),
    configurationRequired: z.array(text(120)).max(10).default([]),
  }).strict()).max(20).default([]),
  routines: z.array(z.object({
    name: text(100),
    description: text(1_000),
    configurationRequired: z.array(text(120)).max(10).default([]),
    enabled: z.literal(false),
  }).strict()).max(10).default([]),
}).strict();

export type EmployeeBundle = z.infer<typeof EmployeeBundleSchema>;

/** Detection is conservative and bounded; review is still required for arbitrary private prose. */
function hasSecretShape(value: unknown): boolean {
  if (typeof value === "string") return redactSecrets(value) !== value ||
    /-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----/.test(value) ||
    /\b(?:password|client_secret|refresh_token|access_token)["']?\s*[:=]\s*["']?[^\s"']{8,}/i.test(value) ||
    /\bsk-(?:proj-|ant-)[A-Za-z0-9_-]{8,}/i.test(value) ||
    /https?:\/\/[^\s/@]+:[^\s/@]+@/i.test(value);
  if (Array.isArray(value)) return value.some(hasSecretShape);
  if (value && typeof value === "object") return Object.values(value).some(hasSecretShape);
  return false;
}

export function validateEmployeeBundle(input: unknown): EmployeeBundle {
  const bundle = EmployeeBundleSchema.parse(input);
  if (hasSecretShape(bundle)) throw new Error("Remove credential-shaped content before sharing this bundle.");
  let bytes = 0;
  for (const character of JSON.stringify(bundle)) {
    const code = character.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes > MAX_EMPLOYEE_BUNDLE_BYTES) throw new Error("Employee bundle is too large.");
  }
  return bundle;
}

export interface EmployeeBundlePreview {
  previewId: string;
  digest: string;
  expiresAt: number;
  recipe: EmployeeBundle;
}

export interface EmployeeBundleImportResult {
  employeeId: string;
  skillIds: string[];
  profileState: "archived_pending_review";
  skillState: "draft";
  requirementsState: "unconfigured";
  routinesState: "descriptions_only";
}
