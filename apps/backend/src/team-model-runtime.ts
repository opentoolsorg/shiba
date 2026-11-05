import { TEAM_MODEL_TEXT_MODEL } from "@shiba/shared";
import type { Env } from "./env.js";
import type { WorkspaceNativeMember } from "./workspace-native-authority.js";
import { membershipSql, updateGuarded } from "./workspace-integrations-store.js";
import {
  TeamModelError, TEAM_MODEL_CALL_TIMEOUT_MS, fundingBinding, fundingContract, readTeamModelFunding, readTeamModelTurn,
  requireTeamModelPolicy, sourceGuard, teamModelTurnHash, type TeamModelFundingRow, type TeamModelInput, type TeamModelSourceSnapshot, type TeamModelTurnRow,
} from "./team-model-store.js";
import { redactSecrets } from "./security.js";

const DB_NOW = "CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";
function exactTurn(row: TeamModelTurnRow) {
  return { sql: "id=? AND grant_id=? AND input_hash=? AND input_json=? AND sources_json=? AND requester_account_id=? AND grant_version=? AND expires_at=?",
    values: [row.id, row.grant_id, row.input_hash, row.input_json, row.sources_json, row.requester_account_id, row.grant_version, row.expires_at] };
}
async function runningCurrent(env: Env, member: WorkspaceNativeMember, grant: TeamModelFundingRow, turn: TeamModelTurnRow) {
  requireTeamModelPolicy(env, grant.policy_key);
  const source = sourceGuard(fundingBinding(grant), JSON.parse(turn.sources_json) as TeamModelSourceSnapshot), actor = membershipSql(member), exact = exactTurn(turn);
  const current = await env.AGENT_AUDIT.prepare(`SELECT 1 AS current WHERE ${source.sql} AND ${actor.sql}
    AND EXISTS(SELECT 1 FROM team_model_funding WHERE id=? AND version=? AND digest=? AND binding_json=? AND contract_json=? AND state='active' AND policy_key=? AND json_extract(contract_json,'$.expiresAt')>${DB_NOW})
    AND EXISTS(SELECT 1 FROM team_model_turns WHERE ${exact.sql} AND status='running' AND expires_at>${DB_NOW} AND dispatch_deadline>${DB_NOW})`)
    .bind(...source.values, ...actor.values, grant.id, turn.grant_version, grant.digest, grant.binding_json, grant.contract_json, grant.policy_key, ...exact.values).first();
  if (!current) throw new TeamModelError("team_model_dispatch_authority_changed", 403);
}
function outputText(value: unknown): string {
  if (!value || typeof value !== "object" || !("choices" in value) || !Array.isArray(value.choices) || value.choices.length !== 1) throw new TeamModelError("team_model_output_unconfirmed");
  const choice: unknown = value.choices[0];
  if (!choice || typeof choice !== "object" || !("message" in choice) || !choice.message || typeof choice.message !== "object" || !("content" in choice.message) || typeof choice.message.content !== "string") throw new TeamModelError("team_model_output_unconfirmed");
  const text = redactSecrets(choice.message.content);
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= 8192) return text;
  const suffix = "\n[truncated]";
  // Streaming decode retains an incomplete trailing code point instead of
  // replacing it with a larger UTF-8 replacement character before the suffix.
  return new TextDecoder("utf-8", { ignoreBOM: true, fatal: false }).decode(bytes.subarray(0, 8192 - new TextEncoder().encode(suffix).byteLength), { stream: true }) + suffix;
}

/** Exactly one application-level AI.run invocation. No provider, tools, retries or orchestration. */
export async function executeTeamModelTurn(env: Env, member: WorkspaceNativeMember, id: string, input: { expectedVersion: number; inputHash: string },
  options: { signal?: AbortSignal; beforeDispatch: () => Promise<void> }) {
  options.signal?.throwIfAborted();
  const turn = await readTeamModelTurn(env, member, id), grant = await readTeamModelFunding(env, member.workspaceId, turn.grant_id);
  const binding = fundingBinding(grant), contract = fundingContract(grant), exact = exactTurn(turn);
  requireTeamModelPolicy(env, grant.policy_key);
  if (binding.recipient.userId !== member.userId || binding.recipient.accountId !== member.accountId || turn.input_hash !== input.inputHash || await teamModelTurnHash(turn, grant) !== turn.input_hash) throw new TeamModelError("team_model_exact_turn_required", 403);
  if (["running", "completed", "unknown", "cancelled", "blocked"].includes(turn.status)) return id;
  if (turn.status !== "approved" || turn.version !== input.expectedVersion || turn.grant_version !== grant.version) throw new TeamModelError("team_model_turn_not_approved", 403);
  const modelInput = JSON.parse(turn.input_json) as TeamModelInput;
  const bytes = new TextEncoder().encode(turn.input_json).byteLength;
  if (bytes !== turn.input_bytes || bytes > contract.maxInputBytes || modelInput.max_completion_tokens !== contract.maxOutputTokens || modelInput.stream !== false || modelInput.n !== 1 || modelInput.tool_choice !== "none" || modelInput.store !== false || JSON.stringify(modelInput.modalities) !== '["text"]' || modelInput.chat_template_kwargs.enable_thinking !== false) throw new TeamModelError("team_model_input_policy_changed", 403);
  await options.beforeDispatch();
  const source = sourceGuard(binding, JSON.parse(turn.sources_json) as TeamModelSourceSnapshot), actor = membershipSql(member);
  const now = Date.now(), dispatchDeadline = Math.min(now + TEAM_MODEL_CALL_TIMEOUT_MS, turn.expires_at, contract.expiresAt);
  options.signal?.throwIfAborted(); requireTeamModelPolicy(env, grant.policy_key);
  if (dispatchDeadline <= now) throw new TeamModelError("team_model_turn_expired", 403);
  const reserved = await env.AGENT_AUDIT.batch([
    env.AGENT_AUDIT.prepare(`UPDATE team_model_funding SET used_requests=used_requests+1,reserved_input_bytes=reserved_input_bytes+?,reserved_output_tokens=reserved_output_tokens+?,updated_at=?
      WHERE id=? AND version=? AND digest=? AND binding_json=? AND contract_json=? AND state='active' AND policy_key=?
        AND used_requests<? AND reserved_input_bytes+?<=? AND reserved_output_tokens+?<=? AND json_extract(contract_json,'$.expiresAt')>${DB_NOW}
        AND ${source.sql} AND ${actor.sql}
        AND EXISTS(SELECT 1 FROM team_model_turns WHERE ${exact.sql} AND version=? AND status='approved' AND expires_at>${DB_NOW})
        AND NOT EXISTS(SELECT 1 FROM team_model_turns busy WHERE busy.grant_id=? AND busy.status IN ('running','unknown'))`)
      .bind(bytes, contract.maxOutputTokens, now, grant.id, turn.grant_version, grant.digest, grant.binding_json, grant.contract_json, grant.policy_key,
        contract.maxRequests, bytes, contract.maxRequests * contract.maxInputBytes, contract.maxOutputTokens, contract.maxRequests * contract.maxOutputTokens,
        ...source.values, ...actor.values, ...exact.values, input.expectedVersion, grant.id),
    env.AGENT_AUDIT.prepare(`UPDATE team_model_turns SET status='running',version=version+1,updated_at=?,dispatch_deadline=? WHERE ${exact.sql} AND version=? AND status='approved' AND changes()=1`)
      .bind(now, dispatchDeadline, ...exact.values, input.expectedVersion),
  ]);
  if (reserved[0]?.meta.changes !== 1 || reserved[1]?.meta.changes !== 1) throw new TeamModelError("team_model_slot_or_authority_changed");

  const controller = new AbortController();
  const relayAbort = () => controller.abort(new Error("team_model_request_cancelled"));
  options.signal?.addEventListener("abort", relayAbort, { once: true });
  if (options.signal?.aborted) relayAbort();
  const timeout = setTimeout(() => controller.abort(new Error("team_model_dispatch_deadline")), Math.max(0, dispatchDeadline - Date.now()));
  let dispatched = false, stopped = false, wake: (() => void) | undefined, pollTimer: ReturnType<typeof setTimeout> | undefined;
  let output: string | null = null, errorCode = "team_model_outcome_unknown";
  let stopPolling: (() => void) | undefined;
  const pollingStopped = new Promise<false>((resolve) => { stopPolling = () => resolve(false); });
  const poll = async () => {
    while (!stopped && !controller.signal.aborted) {
      await new Promise<void>((resolve) => { wake = resolve; pollTimer = setTimeout(resolve, 500); });
      clearTimeout(pollTimer); if (stopped || controller.signal.aborted) break;
      // D1 has no cancellation API. A stalled read may finish later, but it can
      // neither hold cleanup open nor dispatch effects after this local stop.
      const checking = runningCurrent(env, member, grant, turn).then(() => true, () => { if (!stopped) controller.abort(new Error("team_model_cancelled_or_revoked")); return false; });
      if (!await Promise.race([checking, pollingStopped])) break;
    }
  };
  let abortReject: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortReject = () => reject(new TeamModelError("team_model_inflight_interrupted"));
    if (controller.signal.aborted) abortReject(); else controller.signal.addEventListener("abort", abortReject, { once: true });
  });
  // Poll begins only after the final synchronous preflight to avoid parallel DB
  // work racing the final authority snapshot before the first invocation.
  let polling: Promise<void> | undefined;
  try {
    // Attach the abort rejection handler in the same synchronous turn, before
    // waiting on a possibly stalled final authority read.
    await Promise.race([runningCurrent(env, member, grant, turn), aborted]);
    options.signal?.throwIfAborted(); controller.signal.throwIfAborted(); requireTeamModelPolicy(env, grant.policy_key);
    if (Date.now() >= dispatchDeadline || Date.now() >= turn.expires_at || Date.now() >= contract.expiresAt) throw new TeamModelError("team_model_turn_expired", 403);
    // No await, mutable caller argument, credential lookup or fallback here.
    dispatched = true;
    const inference = env.AI.run(TEAM_MODEL_TEXT_MODEL, modelInput, { signal: controller.signal });
    polling = poll();
    const result = await Promise.race([inference, aborted]);
    controller.signal.throwIfAborted(); output = outputText(result);
  } catch { errorCode = dispatched ? "team_model_outcome_unknown" : "team_model_dispatch_blocked"; }
  finally {
    stopped = true; clearTimeout(timeout); if (pollTimer) clearTimeout(pollTimer); wake?.(); stopPolling?.(); await polling;
    if (abortReject) controller.signal.removeEventListener("abort", abortReject); options.signal?.removeEventListener("abort", relayAbort);
  }
  // No result survives cancellation, policy changes or source revocation. The
  // reserved request/bytes/tokens remain consumed for every claimed attempt.
  if (output !== null && !controller.signal.aborted && teamModelPolicyMatches(env, grant.policy_key)) {
    const finalSource = sourceGuard(binding, JSON.parse(turn.sources_json) as TeamModelSourceSnapshot), actor = membershipSql(member);
    const saved = await updateGuarded(env, "team_model_turns", { status: "completed", version: turn.version + 2, output, error_code: null, updated_at: Date.now() },
      `${exact.sql} AND status='running' AND expires_at>${DB_NOW} AND dispatch_deadline>${DB_NOW} AND ${finalSource.sql} AND ${actor.sql}
        AND EXISTS(SELECT 1 FROM team_model_funding WHERE id=? AND version=? AND state='active' AND policy_key=? AND json_extract(contract_json,'$.expiresAt')>${DB_NOW})`,
      [...exact.values, ...finalSource.values, ...actor.values, grant.id, turn.grant_version, grant.policy_key]).run();
    if (saved.meta.changes === 1) return id;
    errorCode = "team_model_result_authority_changed";
  }
  await env.AGENT_AUDIT.prepare("UPDATE team_model_turns SET status=?,version=version+1,output=NULL,error_code=?,updated_at=? WHERE id=? AND status='running'")
    .bind(dispatched ? "unknown" : "blocked", errorCode, Date.now(), id).run();
  return id;
}
function teamModelPolicyMatches(env: Env, key: string) { try { requireTeamModelPolicy(env, key); return true; } catch { return false; } }
