import { stableHash, type JsonValue } from "@shiba/shared";
import type { Env } from "./env.js";
import { timingSafeEqualString } from "./security.js";
import { resolveSandboxDurableObjectId } from "@shiba/shared";
import { validateArchiveReservation, archiveReservationDigest, type ArchiveReservation } from "./run-output-archive-reservations.js";

export type ArchiveAuthorization = { reservation: ArchiveReservation; signature: string };
export type ArchiveSource = { jobId: string; digest: string; epoch: string; currentEpoch: string | null; deadline: number; state: string };
export type ArchiveSourceProof = { reservationDigest: string; jobId: string; digest: string; epoch: string; deadline: number; signature: string };
async function signature(env: Env, scope: string, value: unknown): Promise<string> {
  const key = env.INTERNAL_SIGNING_KEY?.trim() || env.MODEL_CREDENTIAL_KEY;
  if (!key || key.length < 32) throw new Error("Output archive signing is unavailable.");
  const signing = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", signing, new TextEncoder().encode(`${scope}\n${stableHash(value as JsonValue)}`)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
const ADMISSION = "shiba.run-output-archive-admission.v1", SOURCE = "shiba.run-output-archive-native-source.v1";
/** Called only after the approved child envelope and lease reservation were checked. */
export async function sealArchiveAuthorization(env: Env, reservation: ArchiveReservation): Promise<ArchiveAuthorization> {
  validateArchiveReservation(reservation);
  return { reservation, signature: await signature(env, ADMISSION, reservation) };
}
export async function verifyArchiveAuthorization(env: Env, value: ArchiveAuthorization): Promise<void> {
  validateArchiveReservation(value.reservation);
  if (!/^[a-f0-9]{64}$/.test(value.signature) || !timingSafeEqualString(value.signature, await signature(env, ADMISSION, value.reservation)))
    throw new Error("Output archive admission seal is invalid.");
}
/** Binding-only inspection. It never calls startExecution, exec or container.start. */
export async function observeArchiveSource(env: Env, value: ArchiveReservation): Promise<ArchiveSource | null> {
  const stub = env.Sandbox.get(resolveSandboxDurableObjectId(env.Sandbox, value.sandboxId));
  return stub.getExecutionClaim(value.jobId);
}
export async function bindArchiveSource(env: Env, value: ArchiveAuthorization): Promise<ArchiveSourceProof> {
  await verifyArchiveAuthorization(env, value);
  const source = await observeArchiveSource(env, value.reservation);
  if (!source || source.jobId !== value.reservation.jobId || source.deadline !== value.reservation.writeDeadline ||
    !/^[a-f0-9]{64}$/.test(source.digest) || !/^[a-f0-9-]{36}$/.test(source.epoch) || source.currentEpoch !== source.epoch)
    throw new Error("The original native execution claim is unavailable. No replacement command was started.");
  const fields = { reservationDigest: archiveReservationDigest(value.reservation), jobId: source.jobId, digest: source.digest, epoch: source.epoch, deadline: source.deadline };
  return { ...fields, signature: await signature(env, SOURCE, fields) };
}
export async function verifyArchiveSource(env: Env, reservation: ArchiveReservation, value: ArchiveSourceProof): Promise<ArchiveSource | null> {
  const { signature: actual, ...fields } = value;
  if (value.reservationDigest !== archiveReservationDigest(reservation) || value.jobId !== reservation.jobId || value.deadline !== reservation.writeDeadline ||
    !/^[a-f0-9]{64}$/.test(value.digest) || !/^[a-f0-9-]{36}$/.test(value.epoch) || !/^[a-f0-9]{64}$/.test(actual) ||
    !timingSafeEqualString(actual, await signature(env, SOURCE, fields))) throw new Error("Output archive native epoch seal is invalid.");
  const source = await observeArchiveSource(env, reservation);
  return source && source.jobId === value.jobId && source.digest === value.digest && source.epoch === value.epoch && source.currentEpoch === value.epoch && source.deadline === value.deadline ? source : null;
}
