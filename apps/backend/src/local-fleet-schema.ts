/**
 * T52 Worker-boundary validation for the daemon fleet wire shapes. Effect
 * Schema, not zod: the shared module stays plain interfaces (see
 * packages/shared/src/local-fleet.ts) and the asserts below pin the two together.
 */
import { Result, Schema } from "effect";
import type { ConnectedComputer, HeartbeatRequest, PairRequest } from "@shiba/shared";

const Bounded = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max));
const Harnesses = Schema.Array(Bounded(32)).check(Schema.isMaxLength(16));
const PersonalScope = Schema.Struct({ version: Schema.Literal(2), ownerAccountId: Schema.String, actorId: Schema.String, workspaceId: Schema.String,
  membershipVersion: Schema.Number, membershipRole: Schema.Literals(["owner", "admin", "member"]), origin: Schema.String });
const PersonalAccount = Schema.Struct({ schemaVersion: Schema.Literal(1), harness: Schema.Literals(["claude-code", "codex"]), billingMode: Schema.Literal("native-subscription"),
  accountFingerprint: Schema.String, authVersion: Schema.String, cliVersion: Schema.String, probeMethod: Schema.Literals(["claude-auth-status", "codex-account-read"]), probedAt: Schema.Number, receivedAt: Schema.Number });

export const HeartbeatRequestSchema = Schema.Struct({
  machineId: Bounded(64),
  hostname: Bounded(255),
  platform: Bounded(64),
  daemonVersion: Bounded(64),
  harnesses: Harnesses,
  activeRunId: Schema.optional(Bounded(200)),
  reasonNetworkCompanion: Schema.optional(Schema.Boolean),
});

export const PairRequestSchema = Schema.Struct({
  pairingToken: Bounded(1024),
  hostname: Bounded(255),
  platform: Bounded(64),
  daemonVersion: Bounded(64),
  harnesses: Harnesses,
});

export const ConnectedComputerSchema = Schema.Struct({
  machineId: Schema.String,
  hostname: Schema.String,
  platform: Schema.String,
  daemonVersion: Schema.String,
  harnesses: Schema.Array(Schema.String),
  status: Schema.Literals(["idle", "busy", "offline"]),
  lastHeartbeat: Schema.Number,
  pairedAt: Schema.optional(Schema.Number),
  activeRunId: Schema.optional(Schema.String),
  reasonNetworkCompanion: Schema.optional(Schema.Boolean),
  personalExecution: Schema.optional(Schema.Struct({ version: Schema.Literal(1), revision: Schema.Number, scope: PersonalScope, accounts: Schema.Array(PersonalAccount) })),
});

type Mutable<T> = { -readonly [K in keyof T]: T[K] extends readonly (infer U)[] ? U[] : T[K] };
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const assertSame = <T extends true>(): T => true as T;
assertSame<Same<Mutable<typeof HeartbeatRequestSchema.Type>, HeartbeatRequest>>();
assertSame<Same<Mutable<typeof PairRequestSchema.Type>, PairRequest>>();
assertSame<Same<Mutable<typeof ConnectedComputerSchema.Type>, ConnectedComputer>>();

/** The decoded value or null — callers answer 400 on null. */
export function decodeOrNull<S extends Schema.ConstraintDecoder<unknown>>(schema: S, input: unknown): S["Type"] | null {
  const decoded = Schema.decodeUnknownResult(schema)(input);
  return Result.isSuccess(decoded) ? decoded.success : null;
}
