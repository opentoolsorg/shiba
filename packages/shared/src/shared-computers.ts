import { z } from "zod";

/** A human-controlled, offline desktop; never a coding-run runtime or agent tool. */
export const SHARED_COMPUTER_POLICY = "shiba.offline-computer.v1";
export const SHARED_COMPUTER_LIMITS = {
  ttlMs: 600_000,
  leaseMs: 60_000,
  viewers: 8,
  width: 1024,
  height: 768,
  maxInputs: 300,
  minInputIntervalMs: 100,
  maxTextBytes: 1024,
  maxFrames: 120,
  maxFrameBytes: 524_288,
  maxFrameTotalBytes: 16_777_216,
} as const;
const positive = z.number().int().positive(),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
export const sharedComputerMemberSchema = z
  .object({ userId: z.string().email().max(254), version: positive })
  .strict();
export const sharedComputerPrepareSchema = z
  .object({
    requestId: z.string().uuid(),
    roomId: z.string().regex(/^room_[a-f0-9]{24}$/),
    fundingMember: sharedComputerMemberSchema,
    viewers: z.array(sharedComputerMemberSchema).min(1).max(SHARED_COMPUTER_LIMITS.viewers),
    controllers: z.array(z.string().email().max(254)).min(1).max(SHARED_COMPUTER_LIMITS.viewers),
    expiresAt: positive,
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.viewers.map((x) => x.userId)).size === value.viewers.length &&
      new Set(value.controllers).size === value.controllers.length &&
      value.controllers.every((id) => value.viewers.some((x) => x.userId === id)),
    "Choose distinct human viewers and controllers from those viewers.",
  );
export type SharedComputerPrepare = z.infer<typeof sharedComputerPrepareSchema>;
export const sharedComputerReviewSchema = z
  .object({ expectedVersion: positive, digest: hash, reviewed: z.literal(true) })
  .strict();
export const sharedComputerFundingSchema = sharedComputerReviewSchema
  .extend({ billingConsent: z.literal(true) })
  .strict();
export const sharedComputerStartSchema = sharedComputerReviewSchema
  .extend({ sharedDisplayConsent: z.literal(true) })
  .strict();
export const sharedComputerLeaseSchema = z
  .object({
    expectedVersion: positive,
    digest: hash,
    leaseMs: positive.max(SHARED_COMPUTER_LIMITS.leaseMs),
  })
  .strict();
export const sharedComputerActionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("click"),
      x: z.number().int().min(0).max(1023),
      y: z.number().int().min(0).max(767),
      button: z.enum(["left", "middle", "right"]),
    })
    .strict(),
  z.object({ type: z.literal("type"), text: z.string().min(1).max(1024) }).strict(),
  z
    .object({
      type: z.literal("key"),
      key: z.enum([
        "Return",
        "Escape",
        "Tab",
        "BackSpace",
        "Delete",
        "Left",
        "Right",
        "Up",
        "Down",
        "Home",
        "End",
        "Page_Up",
        "Page_Down",
        "space",
      ]),
    })
    .strict(),
  z
    .object({
      type: z.literal("scroll"),
      direction: z.enum(["up", "down", "left", "right"]),
      ticks: positive.max(5),
    })
    .strict(),
]);
export type SharedComputerAction = z.infer<typeof sharedComputerActionSchema>;
export const sharedComputerInputSchema = z
  .object({
    requestId: z.string().uuid(),
    expectedVersion: positive,
    digest: hash,
    leaseVersion: positive,
    sequence: positive.max(SHARED_COMPUTER_LIMITS.maxInputs),
    action: sharedComputerActionSchema,
  })
  .strict();
export const sharedComputerVersionSchema = z.object({ expectedVersion: positive }).strict();
export interface SharedComputerContract {
  policy: typeof SHARED_COMPUTER_POLICY;
  purpose: "offline-human-desktop";
  image: string;
  roomId: string;
  ownerId: string;
  funderId: string;
  viewers: string[];
  controllers: string[];
  expiresAt: number;
  maxSessions: 1;
  instance: "standard-1";
  width: 1024;
  height: 768;
  resources: { vcpu: 0.5; memoryMiB: 4096; diskMB: 8000 };
  limits: typeof SHARED_COMPUTER_LIMITS;
  internet: false;
  credentials: null;
  sources: [];
  estimatedContainerOverageUsd: number;
  estimateNotice: "Resource estimate only; excludes account base charges, Workers, DO, storage and billing-unit rounding.";
}
export interface SharedComputerSession {
  id: string;
  roomId: string;
  version: number;
  digest: string;
  state: "draft" | "funded" | "starting" | "running" | "stopped" | "blocked" | "unknown";
  contract: SharedComputerContract;
  consumed: boolean;
  lease: { ownerId: string; version: number; expiresAt: number } | null;
  nextSequence: number;
  inputCount: number;
  frameCount: number;
  canFund: boolean;
  canStart: boolean;
  canControl: boolean;
  canView: boolean;
  canStop: boolean;
  unavailableReason: string | null;
}
export interface SharedComputerState {
  ok: true;
  enabled: boolean;
  available: boolean;
  unavailableReason: string | null;
  workspaceId: string;
  roomId: string;
  actorId: string;
  sessions: SharedComputerSession[];
  members: Array<{ userId: string; version: number; canFund: boolean }>;
}
const contractSchema = z
  .object({
    policy: z.literal(SHARED_COMPUTER_POLICY),
    purpose: z.literal("offline-human-desktop"),
    image: z
      .string()
      .max(380)
      .regex(/^[a-z0-9][a-z0-9./:_-]{1,300}@sha256:[a-f0-9]{64}$/),
    roomId: z.string().regex(/^room_[a-f0-9]{24}$/),
    ownerId: z.string().email().max(254),
    funderId: z.string().email().max(254),
    viewers: z.array(z.string().email().max(254)).min(1).max(8),
    controllers: z.array(z.string().email().max(254)).min(1).max(8),
    expiresAt: positive,
    maxSessions: z.literal(1),
    instance: z.literal("standard-1"),
    width: z.literal(1024),
    height: z.literal(768),
    resources: z
      .object({ vcpu: z.literal(0.5), memoryMiB: z.literal(4096), diskMB: z.literal(8000) })
      .strict(),
    limits: z
      .object({
        ttlMs: z.literal(600000),
        leaseMs: z.literal(60000),
        viewers: z.literal(8),
        width: z.literal(1024),
        height: z.literal(768),
        maxInputs: z.literal(300),
        minInputIntervalMs: z.literal(100),
        maxTextBytes: z.literal(1024),
        maxFrames: z.literal(120),
        maxFrameBytes: z.literal(524288),
        maxFrameTotalBytes: z.literal(16777216),
      })
      .strict(),
    internet: z.literal(false),
    credentials: z.null(),
    sources: z.tuple([]),
    estimatedContainerOverageUsd: z.number().finite().nonnegative().max(1),
    estimateNotice: z.literal(
      "Resource estimate only; excludes account base charges, Workers, DO, storage and billing-unit rounding.",
    ),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.viewers).size === value.viewers.length &&
      new Set(value.controllers).size === value.controllers.length &&
      value.controllers.every((id) => value.viewers.includes(id)),
    "Invalid display audience.",
  );
export const sharedComputerSessionSchema: z.ZodType<SharedComputerSession> = z
  .object({
    id: z.string().regex(/^scs_[a-f0-9]{32}$/),
    roomId: z.string().regex(/^room_[a-f0-9]{24}$/),
    version: positive,
    digest: hash,
    state: z.enum(["draft", "funded", "starting", "running", "stopped", "blocked", "unknown"]),
    contract: contractSchema,
    consumed: z.boolean(),
    lease: z
      .object({ ownerId: z.string().email().max(254), version: positive, expiresAt: positive })
      .strict()
      .nullable(),
    nextSequence: positive.max(301),
    inputCount: z.number().int().nonnegative().max(300),
    frameCount: z.number().int().nonnegative().max(120),
    canFund: z.boolean(),
    canStart: z.boolean(),
    canControl: z.boolean(),
    canView: z.boolean(),
    canStop: z.boolean(),
    unavailableReason: z.string().max(200).nullable(),
  })
  .strict()
  .refine((value) => value.roomId === value.contract.roomId, "Session room mismatch.");
export const sharedComputerStateSchema: z.ZodType<SharedComputerState> = z
  .object({
    ok: z.literal(true),
    enabled: z.boolean(),
    available: z.boolean(),
    unavailableReason: z.string().max(200).nullable(),
    workspaceId: z.string().min(1).max(128),
    roomId: z.string().regex(/^room_[a-f0-9]{24}$/),
    actorId: z.string().email().max(254),
    sessions: z.array(sharedComputerSessionSchema).max(20),
    members: z.array(sharedComputerMemberSchema.extend({ canFund: z.boolean() }).strict()).max(100),
  })
  .strict();
export const sharedComputerResponseSchema = z
  .object({ ok: z.literal(true), session: sharedComputerSessionSchema })
  .strict();
