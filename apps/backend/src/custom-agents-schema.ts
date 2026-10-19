import { Result, Schema } from "effect";
import {
  CUSTOM_AGENT_APPROVAL_POLICIES,
  CUSTOM_AGENT_SANDBOX_PROVIDERS,
  type CustomAgentConfig,
} from "@shiba/shared";

const Bounded = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max));

export const CustomAgentConfigSchema = Schema.Struct({
  name: Bounded(120),
  emoji: Schema.optional(Bounded(16)),
  instructions: Bounded(32_000),
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
  expectedVersion: Schema.optional(Schema.Number),
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
