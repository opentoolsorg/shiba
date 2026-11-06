import { SHARED_COMPUTER_LIMITS as LIMIT, sharedComputerActionSchema, type SharedComputerAction } from "@shiba/shared";
import { hashToolArgs } from "./mcp-gateway.js";
import { redactSecrets } from "./security.js";
import { membershipSql, updateGuarded } from "./workspace-integrations-store.js";
import type { WorkspaceNativeMember } from "./workspace-native-authority.js";
import { assertComputerCurrent, claimComputerStart, computerBinding, computerContract, computerSourceSql, COMPUTER_DB_NOW, readComputerRow, requireComputerPolicy, SharedComputerError, type ComputerRow, type SharedComputerEnv } from "./shared-computer-store.js";
import { signComputerOperation } from "./shared-computer-auth.js";

export function computerInputArgv(raw: SharedComputerAction): string[] {
  const parsed = sharedComputerActionSchema.safeParse(raw);
  if (!parsed.success) throw new SharedComputerError("shared_computer_input_invalid", 400);
  const action = parsed.data;
  if (action.type === "click") return ["xdotool", "mousemove", "--sync", String(action.x), String(action.y), "click", String({ left: 1, middle: 2, right: 3 }[action.button])];
  if (action.type === "key") return ["xdotool", "key", "--clearmodifiers", action.key];
  if (action.type === "scroll") return ["xdotool", "click", "--repeat", String(action.ticks), String({ up: 4, down: 5, left: 6, right: 7 }[action.direction])];
  const unsafeControl = Array.from(action.text).some((character) => { const code = character.charCodeAt(0); return code <= 8 || (code >= 11 && code <= 31) || code === 127; });
  if (new TextEncoder().encode(action.text).byteLength > LIMIT.maxTextBytes || unsafeControl || redactSecrets(action.text) !== action.text) throw new SharedComputerError("shared_computer_text_invalid", 400);
  return ["xdotool", "type", "--clearmodifiers", "--delay", "0", "--", action.text];
}
interface DispatchOptions { signal?: AbortSignal; beforeDispatch?: () => Promise<void> }
const namespace = (env: SharedComputerEnv) => { if (!env.ComputerSession) throw new SharedComputerError("shared_computer_runtime_unavailable", 503); return env.ComputerSession; };
function handle(env: SharedComputerEnv, id: string) { const binding = namespace(env); return binding.get(binding.idFromName(id)); }
export async function startSharedComputer(env: SharedComputerEnv, actor: WorkspaceNativeMember, row: ComputerRow, digest: string, options: DispatchOptions) {
  const claimed = await claimComputerStart(env, actor, row, digest);
  try {
    const capsule = await signComputerOperation(env, claimed, actor, { operation: "start" });
    await options.beforeDispatch?.(); await assertComputerCurrent(env, claimed, actor);
    options.signal?.throwIfAborted(); requireComputerPolicy(env, computerContract(claimed).image);
    await handle(env, row.id).startSession(capsule);
  } catch {
    await env.AGENT_AUDIT.prepare("UPDATE shared_computer_sessions SET state='unknown',version=version+1,lease_expires_at=0,updated_at=? WHERE id=? AND state='starting'").bind(Date.now(), row.id).run();
    // An uncertain start is retained and not refunded/replayed. Only this
    // dedicated purpose's stop RPC may be used to limit its runtime.
    const stop = await signComputerOperation(env, await readComputerRow(env, actor.workspaceId, row.id), actor, { operation: "stop" });
    await handle(env, row.id).stopSession(stop).catch(() => {});
    throw new SharedComputerError("shared_computer_start_outcome_unknown", 503);
  }
}
export async function inputSharedComputer(env: SharedComputerEnv, actor: WorkspaceNativeMember, row: ComputerRow,
  input: { requestId: string; digest: string; expectedVersion: number; leaseVersion: number; sequence: number; action: SharedComputerAction }, options: DispatchOptions) {
  computerInputArgv(input.action);
  if (input.digest !== row.digest || input.expectedVersion !== row.version || !computerContract(row).controllers.includes(actor.userId)) throw new SharedComputerError("shared_computer_input_scope_changed", 403);
  await assertComputerCurrent(env, row, actor, true); const member = membershipSql(actor), now = Date.now(), actionHash = await hashToolArgs(input.action);
  // No raw typed text or screenshot bytes are persisted in the audit rows.
  const results = await env.AGENT_AUDIT.batch([
    env.AGENT_AUDIT.prepare(`UPDATE shared_computer_sessions SET sequence=?,input_count=input_count+1,last_input_at=?,updated_at=?
      WHERE id=? AND version=? AND digest=? AND state='running' AND lease_account_id=? AND lease_owner=? AND lease_version=? AND lease_expires_at>${COMPUTER_DB_NOW}
      AND sequence=? AND input_count<? AND last_input_at<=? AND json_extract(contract_json,'$.expiresAt')>${COMPUTER_DB_NOW} AND ${member.sql}
      AND NOT EXISTS(SELECT 1 FROM shared_computer_commands WHERE session_id=? AND status IN ('claimed','unknown'))
      AND EXISTS(SELECT 1 FROM shared_computer_sessions s WHERE s.id=shared_computer_sessions.id AND ${computerSourceSql()})`)
      .bind(input.sequence, now, now, row.id, row.version, row.digest, actor.accountId, actor.userId, input.leaseVersion, input.sequence - 1, LIMIT.maxInputs, now - LIMIT.minInputIntervalMs, ...member.values, row.id),
    env.AGENT_AUDIT.prepare("INSERT INTO shared_computer_commands(session_id,request_id,sequence,action_hash,status,created_at) SELECT ?,?,?,?,'claimed',? WHERE changes()=1")
      .bind(row.id, input.requestId, input.sequence, actionHash, now),
  ]);
  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) throw new SharedComputerError("shared_computer_input_claim_refused");
  try {
    const capsule = await signComputerOperation(env, row, actor, { operation: "input", requestId: input.requestId, sequence: input.sequence, leaseVersion: input.leaseVersion, actionHash });
    await options.beforeDispatch?.(); const current = await readComputerRow(env, actor.workspaceId, row.id); await assertComputerCurrent(env, current, actor, true);
    options.signal?.throwIfAborted(); requireComputerPolicy(env, computerContract(current).image);
    await handle(env, row.id).applyInput(capsule, input.action);
  } catch {
    await env.AGENT_AUDIT.batch([
      env.AGENT_AUDIT.prepare("UPDATE shared_computer_commands SET status='unknown' WHERE session_id=? AND request_id=? AND status='claimed'").bind(row.id, input.requestId),
      env.AGENT_AUDIT.prepare("UPDATE shared_computer_sessions SET state='unknown',version=version+1,lease_expires_at=0 WHERE id=? AND state='running'").bind(row.id),
    ]);
    // The private TTL/revocation alarm destroys this uncertain generation.
    // A controller's input authorization never becomes owner STOP authority.
    throw new SharedComputerError("shared_computer_input_outcome_unknown", 503);
  }
}
export async function frameSharedComputer(env: SharedComputerEnv, actor: WorkspaceNativeMember, row: ComputerRow, options: DispatchOptions) {
  if (!computerContract(row).viewers.includes(actor.userId)) throw new SharedComputerError("shared_computer_viewer_required", 403);
  await assertComputerCurrent(env, row, actor, true); const member = membershipSql(actor), now = Date.now();
  const reserved = await updateGuarded(env, "shared_computer_sessions", { last_frame_at: now, frame_count: row.frame_count + 1, frame_bytes: row.frame_bytes + LIMIT.maxFrameBytes },
    `id=? AND version=? AND frame_count=? AND state='running' AND frame_count<? AND frame_bytes+?<=? AND last_frame_at<=? AND json_extract(contract_json,'$.expiresAt')>${COMPUTER_DB_NOW} AND ${member.sql}
      AND EXISTS(SELECT 1 FROM shared_computer_sessions s WHERE s.id=shared_computer_sessions.id AND ${computerSourceSql()})`,
    [row.id, row.version, row.frame_count, LIMIT.maxFrames, LIMIT.maxFrameBytes, LIMIT.maxFrameTotalBytes, now - 1000, ...member.values]).run();
  if (reserved.meta.changes !== 1) throw new SharedComputerError("shared_computer_capture_limit", 429);
  const capsule = await signComputerOperation(env, row, actor, { operation: "capture" });
  await options.beforeDispatch?.(); await assertComputerCurrent(env, row, actor, true); options.signal?.throwIfAborted();
  const image = await handle(env, row.id).captureFrame(capsule);
  if (!(image instanceof Uint8Array) || image.byteLength > LIMIT.maxFrameBytes || image.byteLength < 4 || image[0] !== 0xff || image[1] !== 0xd8) throw new SharedComputerError("shared_computer_capture_unavailable", 503);
  await options.beforeDispatch?.(); await assertComputerCurrent(env, row, actor, true); options.signal?.throwIfAborted(); requireComputerPolicy(env, computerContract(row).image);
  return image;
}
export async function stopSharedComputer(env: SharedComputerEnv, accountId: string, row: ComputerRow) {
  const binding = computerBinding(row);
  if (accountId !== binding.owner.accountId && accountId !== binding.funder.accountId) throw new SharedComputerError("shared_computer_stop_owner_required", 403);
  if (row.consumed === 0) {
    // Withdrawing a draft/funded grant must not instantiate a runtime or
    // contend with the deployment's one actual allocation.
    await env.AGENT_AUDIT.prepare("UPDATE shared_computer_sessions SET state='stopped',version=version+1,lease_expires_at=0,updated_at=? WHERE id=? AND consumed=0").bind(Date.now(), row.id).run();
    return;
  }
  // Retained native ownership permits stop after membership/funding expiry.
  // No source revalidation here can accidentally prevent safe destruction.
  await env.AGENT_AUDIT.prepare("UPDATE shared_computer_sessions SET state='unknown',version=version+1,lease_expires_at=0,updated_at=? WHERE id=? AND state<>'stopped'").bind(Date.now(), row.id).run();
  const current = await readComputerRow(env, row.workspace_id, row.id);
  const capsule = await signComputerOperation(env, current, { accountId, userId: accountId === binding.owner.accountId ? binding.owner.userId : binding.funder.userId }, { operation: "stop" });
  await handle(env, row.id).stopSession(capsule);
}
