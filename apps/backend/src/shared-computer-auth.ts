import { z } from "zod";
import { SharedComputerError, type SharedComputerEnv, type ComputerRow } from "./shared-computer-store.js";
import type { WorkspaceNativeMember } from "./workspace-native-authority.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/), positive = z.number().int().positive();
const detailsSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("start") }).strict(),
  z.object({ operation: z.literal("capture") }).strict(),
  z.object({ operation: z.literal("stop") }).strict(),
  z.object({ operation: z.literal("input"), requestId: z.string().uuid(), sequence: positive.max(300), leaseVersion: positive, actionHash: hash }).strict(),
]);
const bodySchema = z.object({ scope: z.literal("shiba.offline-computer-operation.v1"), id: z.string().uuid(),
  sessionId: z.string().regex(/^scs_[a-f0-9]{32}$/), workspaceId: z.string().min(1).max(128), version: positive, digest: hash,
  actorId: z.string().email().max(254), accountId: z.string().min(1).max(128), issuedAt: positive, expiresAt: positive, details: detailsSchema,
}).strict();
export type ComputerOperationDetails = z.infer<typeof detailsSchema>;
export interface ComputerOperation { body: z.infer<typeof bodySchema>; signature: string }
async function key(env: SharedComputerEnv) {
  if (!env.INTERNAL_SIGNING_KEY || env.INTERNAL_SIGNING_KEY.length < 32) throw new SharedComputerError("shared_computer_signing_unavailable", 503);
  return crypto.subtle.importKey("raw", new TextEncoder().encode(env.INTERNAL_SIGNING_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
/** Backend-only: no browser/model-supplied authority or capsule is accepted. */
export async function signComputerOperation(env: SharedComputerEnv, row: ComputerRow, actor: Pick<WorkspaceNativeMember, "accountId" | "userId">, details: ComputerOperationDetails): Promise<ComputerOperation> {
  const issuedAt = Date.now(), body = bodySchema.parse({ scope: "shiba.offline-computer-operation.v1", id: crypto.randomUUID(), sessionId: row.id, workspaceId: row.workspace_id,
    version: row.version, digest: row.digest, actorId: actor.userId, accountId: actor.accountId, issuedAt, expiresAt: issuedAt + 10000, details });
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await key(env), new TextEncoder().encode(JSON.stringify(body))));
  return { body, signature: Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("") };
}
export async function verifyComputerOperation(env: SharedComputerEnv, raw: unknown, operation: ComputerOperationDetails["operation"]) {
  const parsed = z.object({ body: bodySchema, signature: hash }).strict().safeParse(raw);
  if (!parsed.success) throw new SharedComputerError("shared_computer_operation_invalid", 403);
  const { body, signature } = parsed.data, now = Date.now();
  if (body.details.operation !== operation || body.issuedAt > now + 1000 || body.expiresAt <= now || body.expiresAt > body.issuedAt + 10000 || body.expiresAt <= body.issuedAt) throw new SharedComputerError("shared_computer_operation_expired_or_scope_changed", 403);
  const valid = await crypto.subtle.verify("HMAC", await key(env), Uint8Array.from(signature.match(/../g)!, (pair) => Number.parseInt(pair, 16)), new TextEncoder().encode(JSON.stringify(body)));
  if (!valid || body.expiresAt <= Date.now()) throw new SharedComputerError("shared_computer_operation_invalid", 403);
  return body;
}
