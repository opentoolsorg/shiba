import { Result, Schema } from "effect";
import {
  AGENT_AVATAR_COATS,
  AGENT_AVATAR_VARIANTS,
  CUSTOM_AGENT_APPROVAL_POLICIES,
  AGENT_MASCOT_ACCS,
  AGENT_MASCOT_EYES,
  AGENT_MASCOT_SHAPES,
  CUSTOM_AGENT_MASCOT_PRESETS,
  CUSTOM_AGENT_SANDBOX_PROVIDERS,
  CUSTOM_AGENT_DEPARTMENTS,
  CUSTOM_AGENT_ROLE_TEMPLATE_IDS,
  MAX_BOT_LIBRARY_FILES,
  BOT_LIBRARY_FILE_ID,
  expectedDeliverablesSchema,
  type CustomAgentConfig,
} from "@shiba/shared";

const Bounded = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max));

export const CustomAgentConfigSchema = Schema.Struct({
  name: Bounded(120),
  title: Schema.optional(Bounded(120)),
  department: Schema.optional(Schema.Literals(CUSTOM_AGENT_DEPARTMENTS)),
  reportsTo: Schema.optional(Schema.Union([
    Schema.Struct({ kind: Schema.Literal("user"), userId: Bounded(120) }),
    Schema.Struct({ kind: Schema.Literal("agent"), agentId: Bounded(120) }),
  ])),
  channelIdentities: Schema.optional(Schema.Struct({
    slack: Schema.optional(Bounded(120)),
    discord: Schema.optional(Bounded(120)),
    email: Schema.optional(Bounded(320)),
  })),
  primaryComputerId: Schema.optional(Bounded(120)),
  emoji: Schema.optional(Bounded(16)),
  mascotPreset: Schema.optional(Schema.Literals(CUSTOM_AGENT_MASCOT_PRESETS)),
  look: Schema.optional(Schema.Struct({
    shape: Schema.Literals(AGENT_MASCOT_SHAPES),
    color: Schema.String.check(Schema.makeFilter((value: string) => /^#[0-9A-Fa-f]{6}$/.test(value) || "Fur color must be a 6-digit hex.")),
    eyes: Schema.Literals(AGENT_MASCOT_EYES),
    acc: Schema.Literals(AGENT_MASCOT_ACCS),
  })),
  avatar: Schema.optional(Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("variant"),
      variant: Schema.Literals(AGENT_AVATAR_VARIANTS.map((variant) => variant.id)),
      color: Schema.Literals(AGENT_AVATAR_COATS),
    }),
    Schema.Struct({
      kind: Schema.Literal("upload"),
      fileId: Schema.String.check(Schema.makeFilter((value: string) => /^file_[A-Za-z0-9]{4,64}$/.test(value) || "An avatar upload must name a stored file id.")),
    }),
  ])),
  roleTemplateId: Schema.optional(Schema.Literals(CUSTOM_AGENT_ROLE_TEMPLATE_IDS)),
  instructions: Bounded(32_000),
  expectedDeliverables: Schema.optional(Schema.Array(Bounded(240)).check(
    Schema.makeFilter((paths) => expectedDeliverablesSchema.safeParse(paths).success || "Invalid expected deliverable paths."),
  )),
  libraryFileIds: Schema.optional(Schema.Array(Bounded(64)).check(
    Schema.isMaxLength(MAX_BOT_LIBRARY_FILES),
    Schema.makeFilter((ids: ReadonlyArray<string>) => new Set(ids).size === ids.length || "Library file ids must be unique."),
    Schema.makeFilter((ids: ReadonlyArray<string>) => ids.every((id) => BOT_LIBRARY_FILE_ID.test(id)) || "Library links must be knowledge file ids."),
  )),
  harness: Bounded(64),
  codingModel: Schema.optional(Bounded(200)),
  connectionId: Schema.optional(Bounded(120)),
  sandboxProvider: Schema.optional(Schema.Literals(CUSTOM_AGENT_SANDBOX_PROVIDERS)),
  defaultRepoUrl: Schema.optional(Bounded(500)),
  approvalPolicy: Schema.optional(Schema.Literals(CUSTOM_AGENT_APPROVAL_POLICIES)),
  toolScopes: Schema.optional(Schema.Array(Bounded(64)).check(Schema.isMaxLength(32))),
});

export const CreateCustomAgentSchema = Schema.Struct({
  slug: Bounded(48),
  config: CustomAgentConfigSchema,
});

export const UpdateCustomAgentSchema = Schema.Struct({
  config: CustomAgentConfigSchema,
  expectedVersion: Schema.optional(Schema.Number.check(
    Schema.isInt(), Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  )),
});

export type CreateCustomAgentInput = Schema.Schema.Type<typeof CreateCustomAgentSchema>;
export type UpdateCustomAgentInput = Schema.Schema.Type<typeof UpdateCustomAgentSchema>;

function decodeOrNull<S extends Schema.ConstraintDecoder<unknown>>(schema: S, input: unknown): S["Type"] | null {
  const decoded = Schema.decodeUnknownResult(schema)(input);
  return Result.isSuccess(decoded) ? decoded.success : null;
}

export function decodeCustomAgentConfig(input: unknown): CustomAgentConfig | null {
  return decodeOrNull(CustomAgentConfigSchema, input);
}

export function decodeCreateCustomAgent(input: unknown): CreateCustomAgentInput | null {
  return decodeOrNull(CreateCustomAgentSchema, input);
}

export function decodeUpdateCustomAgent(input: unknown): UpdateCustomAgentInput | null {
  return decodeOrNull(UpdateCustomAgentSchema, input);
}
