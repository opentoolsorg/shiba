import { signInternal, verifyInternal } from "./security/signing.js";
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
/** Backend-only: no browser/model-supplied authority or capsule is accepted. */
export async function signComputerOperation(env: SharedComputerEnv, row: ComputerRow, actor: Pick<WorkspaceNativeMember, "accountId" | "userId">, details: ComputerOperationDetails): Promise<ComputerOperation> {
  const issuedAt = Date.now(), body = bodySchema.parse({ scope: "shiba.offline-computer-operation.v1", id: crypto.randomUUID(), sessionId: row.id, workspaceId: row.workspace_id,
    version: row.version, digest: row.digest, actorId: actor.userId, accountId: actor.accountId, issuedAt, expiresAt: issuedAt + 10000, details });
  if (!env.INTERNAL_SIGNING_KEY || env.INTERNAL_SIGNING_KEY.length < 32) throw new SharedComputerError("shared_computer_signing_unavailable", 503);
  return { body, signature: await signInternal(env, "shiba/shared-computer-operation/v1", JSON.stringify(body)) };
}
export async function verifyComputerOperation(env: SharedComputerEnv, raw: unknown, operation: ComputerOperationDetails["operation"]) {
  const parsed = z.object({ body: bodySchema, signature: z.string().regex(/^(?:v1:[a-f0-9]{16}:)?[a-f0-9]{64}$/) }).strict().safeParse(raw);
  if (!parsed.success) throw new SharedComputerError("shared_computer_operation_invalid", 403);
  const { body, signature } = parsed.data, now = Date.now();
  if (body.details.operation !== operation || body.issuedAt > now + 1000 || body.expiresAt <= now || body.expiresAt > body.issuedAt + 10000 || body.expiresAt <= body.issuedAt) throw new SharedComputerError("shared_computer_operation_expired_or_scope_changed", 403);
  const valid = await verifyInternal(env, "shiba/shared-computer-operation/v1", JSON.stringify(body), signature, env.INTERNAL_SIGNING_KEY?.trim());
  if (!valid || body.expiresAt <= Date.now()) throw new SharedComputerError("shared_computer_operation_invalid", 403);
  return body;
}
