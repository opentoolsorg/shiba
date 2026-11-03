import { z } from "zod";
import type { Env } from "../../env.js";
import { timingSafeEqualString } from "../../security.js";

export const SPECIALIST_TIMEOUT_MS = 60_000;
export const MAX_SPECIALIST_INPUT_CHARS = 128_000;
export const MAX_SPECIALIST_TASKS_PER_TURN = 3;

const fileSchema = z.strictObject({
  path: z.string().min(1).max(512).refine((path) =>
    !path.startsWith("/") && !path.includes("\\") && !path.split("/").includes("..") && !path.includes("\0"),
  "File paths must stay within the supplied snapshot."),
  content: z.string().max(32_000),
});

export const exploreInputSchema = z.strictObject({
  goal: z.string().trim().min(1).max(4_000),
  context: z.string().max(16_000).default(""),
  files: z.array(fileSchema).min(1).max(32),
}).refine((input) => JSON.stringify(input).length <= MAX_SPECIALIST_INPUT_CHARS, "Snapshot is too large.")
  .refine((input) => new Set(input.files.map((file) => file.path)).size === input.files.length, "Snapshot paths must be unique.");

export const reviewInputSchema = z.strictObject({
  goal: z.string().trim().min(1).max(4_000),
  context: z.string().max(16_000).default(""),
  specification: z.string().min(1).max(32_000),
  diff: z.string().max(64_000),
});

export type ExploreInput = z.infer<typeof exploreInputSchema>;
export type SpecialistRole = "explorer" | "reviewer";

export const specialistObservationSchema = z.strictObject({
  agent: z.enum(["explorer", "reviewer"]),
  status: z.enum(["completed", "failed"]),
  summary: z.string().min(1).max(4_000),
  report: z.string().max(16_000),
  findings: z.array(z.strictObject({
    severity: z.enum(["info", "warning", "error"]),
    path: z.string().max(512).optional(),
    message: z.string().min(1).max(2_000),
  })).max(24),
});

export interface ChildTaskEvent {
  kind: "ChildTaskSpawned" | "ChildTaskProgress" | "ChildTaskCompleted" | "ChildTaskFailed";
  childTaskId: string;
  agent: SpecialistRole;
  parentName: string;
  summary?: string;
}

const dispatchSchema = z.strictObject({
  version: z.literal(1),
  role: z.enum(["explorer", "reviewer"]),
  parentName: z.string().min(1).max(1024),
  childTaskId: z.string().min(1).max(512),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  input: z.unknown(),
  signature: z.string().regex(/^[a-f0-9]{64}$/),
});
export type SpecialistDispatch = z.infer<typeof dispatchSchema>;
type DispatchEnv = Pick<Env, "INTERNAL_SIGNING_KEY" | "MODEL_CREDENTIAL_KEY">;

function dispatchKey(env: DispatchEnv): string {
  const key = env.INTERNAL_SIGNING_KEY?.trim() || env.MODEL_CREDENTIAL_KEY?.trim();
  if (!key) throw new Error("Specialist dispatch signing is not configured.");
  return key;
}

async function dispatchSignature(env: DispatchEnv, dispatch: Omit<SpecialistDispatch, "signature">): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(dispatchKey(env)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const result = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(JSON.stringify([
    "shiba-readonly-specialist-v1", dispatch.version, dispatch.role, dispatch.parentName,
    dispatch.childTaskId, dispatch.issuedAt, dispatch.expiresAt, dispatch.input,
  ])));
  return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sealSpecialistDispatch(
  env: DispatchEnv,
  role: SpecialistRole,
  parentName: string,
  childTaskId: string,
  input: unknown,
  now = Date.now(),
): Promise<SpecialistDispatch> {
  const request = role === "explorer" ? exploreInputSchema.parse(input) : reviewInputSchema.parse(input);
  const unsigned = { version: 1 as const, role, parentName, childTaskId, issuedAt: now, expiresAt: now + SPECIALIST_TIMEOUT_MS, input: request };
  return dispatchSchema.parse({ ...unsigned, signature: await dispatchSignature(env, unsigned) });
}

export async function verifySpecialistDispatch(
  env: DispatchEnv,
  value: unknown,
  role: SpecialistRole,
  parentPath: readonly { className: string; name: string }[],
  now = Date.now(),
): Promise<SpecialistDispatch> {
  const dispatch = dispatchSchema.parse(value);
  if (dispatch.role !== role || parentPath.length !== 1 || parentPath[0]?.className !== "CodingOrchestrator" || parentPath[0]?.name !== dispatch.parentName) {
    throw new Error("Specialist dispatch parent or role is invalid.");
  }
  if (dispatch.issuedAt > now || dispatch.expiresAt <= now || dispatch.expiresAt - dispatch.issuedAt > SPECIALIST_TIMEOUT_MS) {
    throw new Error("Specialist execution deadline exceeded.");
  }
  const { signature, ...unsigned } = dispatch;
  if (!timingSafeEqualString(signature, await dispatchSignature(env, unsigned))) {
    throw new Error("Specialist dispatch signature is invalid.");
  }
  if (role === "explorer") exploreInputSchema.parse(dispatch.input);
  else reviewInputSchema.parse(dispatch.input);
  return dispatch;
}

export async function withinSpecialistDeadline<T>(operation: (signal: AbortSignal) => Promise<T>, expiresAt: number, signal?: AbortSignal): Promise<T> {
  if (expiresAt <= Date.now()) throw new Error("Specialist execution deadline exceeded.");
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    controller.signal.throwIfAborted();
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_, reject) => {
        const onAbort = () => reject(new Error("Specialist execution cancelled."));
        controller.signal.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => {
          reject(new Error("Specialist execution deadline exceeded."));
          controller.abort();
        }, Math.max(0, Math.min(SPECIALIST_TIMEOUT_MS, expiresAt - Date.now())));
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
