import { DurableObject } from "cloudflare:workers";
import { Files } from "@cloudflare/sandbox";
import { SHARED_COMPUTER_LIMITS as LIMIT, type SharedComputerAction } from "@shiba/shared";
import { hashToolArgs } from "./mcp-gateway.js";
import { computerInputArgv } from "./shared-computer-runtime.js";
import { verifyComputerOperation, type ComputerOperation } from "./shared-computer-auth.js";
import { nativeWorkspaceAccountSql } from "./workspace-native-authority.js";
import { assertComputerCurrent, computerBinding, computerContract, computerSourceSql, COMPUTER_DB_NOW, readComputerRow, requireComputerPolicy, SharedComputerError, type ComputerRow, type SharedComputerEnv } from "./shared-computer-store.js";

const DISPLAY = ":1";
const MAX_PROCESS_BYTES = 4096;
/** This DO owns exactly one offline desktop VM. It is never attached to a coding run. */
export class ComputerSession extends DurableObject<SharedComputerEnv> {
  #container: Container | undefined;
  #retired = false;
  constructor(ctx: DurableObjectState, env: SharedComputerEnv) {
    super(ctx, env); this.#container = ctx.container;
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS computer_once(kind TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(kind,id))");
    this.#retired = ctx.storage.sql.exec("SELECT 1 FROM computer_once WHERE kind='retired' LIMIT 1").toArray().length > 0;
  }
  async fetch(): Promise<Response> { return new Response("Not found", { status: 404 }); }
  #bound(id: string) {
    if (!/^scs_[a-f0-9]{32}$/.test(id) || !this.env.ComputerSession || !this.ctx.id.equals(this.env.ComputerSession.idFromName(id))) throw new SharedComputerError("shared_computer_runtime_scope_invalid", 403);
    if (!this.#container) throw new SharedComputerError("shared_computer_runtime_unavailable", 503);
    return this.#container;
  }
  #once(kind: string, id: string) {
    const result = this.ctx.storage.sql.exec("INSERT OR IGNORE INTO computer_once(kind,id) VALUES(?,?)", kind, id);
    if (result.rowsWritten !== 1) throw new SharedComputerError("shared_computer_attempt_already_consumed");
  }
  #assertLive() { if (this.#retired) throw new SharedComputerError("shared_computer_generation_retired", 403); }
  async #deadline<T>(timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController(); let rejectTimeout: (() => void) | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => { rejectTimeout = () => reject(new SharedComputerError("shared_computer_runtime_timeout", 503)); });
    const timer = setTimeout(() => { controller.abort(); rejectTimeout!(); }, timeoutMs);
    try { return await Promise.race([run(controller.signal), timedOut]); }
    finally { clearTimeout(timer); }
  }
  async #process(container: Container, argv: string[], timeoutMs = 5000) {
    return this.#deadline(timeoutMs, async (signal) => {
      const process = await container.exec(argv, { env: { DISPLAY, HOME: "/home/desktop", PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe", signal });
      const read = async (stream: ReadableStream | null | undefined) => {
        if (!stream) return;
        const reader = stream.getReader(); let bytes = 0;
          try { for (;;) { signal.throwIfAborted(); const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > MAX_PROCESS_BYTES) { process.kill(9); throw new SharedComputerError("shared_computer_process_output_limit", 503); } } }
        finally { await reader.cancel().catch(() => {}); }
      };
      const [, , exit] = await Promise.all([read(process.stdout), read(process.stderr), process.exitCode]);
      if (exit !== 0) throw new SharedComputerError("shared_computer_display_unavailable", 503);
    });
  }
  async #running(id: string, row: ComputerRow) {
    this.#assertLive();
    const container = this.#bound(id); requireComputerPolicy(this.env, computerContract(row).image);
    if (!container.running) throw new SharedComputerError("shared_computer_container_lost", 503);
    const inspected = await container.inspect();
    this.#assertLive();
    if (!inspected || inspected.image !== computerContract(row).image || inspected.labels?.purpose !== "offline-desktop" || inspected.labels?.session !== id) throw new SharedComputerError("shared_computer_container_identity_changed", 503);
    return container;
  }
  async startSession(capsule: ComputerOperation): Promise<void> {
    const operation = await verifyComputerOperation(this.env, capsule, "start"), id = operation.sessionId, expectedVersion = operation.version, digest = operation.digest;
    const container = this.#bound(id); this.#assertLive(); this.#once("operation", operation.id);
    const row = await readComputerRow(this.env, operation.workspaceId, id), contract = computerContract(row);
    if (computerBinding(row).owner.accountId !== operation.accountId || computerBinding(row).owner.userId !== operation.actorId) throw new SharedComputerError("shared_computer_owner_required", 403);
    if (row.state !== "starting" || row.version !== expectedVersion || row.digest !== digest || row.consumed !== 1 || contract.purpose !== "offline-human-desktop" || container.images.computer !== contract.image) throw new SharedComputerError("shared_computer_creation_not_approved", 403);
    this.#once("start", id); // durable before any allocation; uncertain calls never restart
    await this.ctx.storage.put("session-id", id); await this.ctx.storage.setAlarm(Math.min(Date.now() + 1000, contract.expiresAt));
    await assertComputerCurrent(this.env, row); requireComputerPolicy(this.env, contract.image);
    if (Date.now() >= contract.expiresAt || Date.now() >= operation.expiresAt || container.running) throw new SharedComputerError("shared_computer_creation_changed", 403);
    this.#assertLive();
    // No Worker env, credential, host mount, existing CLI process or egress
    // interceptor is passed. The image contains a fail-closed expiry watchdog.
    container.start({ image: contract.image, instance: "standard-1", enableInternet: false,
      env: { SHIBA_COMPUTER_EXPIRES_AT: String(contract.expiresAt) }, labels: { purpose: "offline-desktop", session: id } });
    try {
      await container.setInactivityTimeout(30_000);
      await this.#process(container, ["/usr/local/bin/shiba-computer-ready"], 20_000);
      await assertComputerCurrent(this.env, row); requireComputerPolicy(this.env, contract.image);
      const ready = await this.env.AGENT_AUDIT.prepare(`UPDATE shared_computer_sessions SET state='running',version=version+1,updated_at=?
        WHERE id=? AND version=? AND state='starting' AND digest=? AND json_extract(contract_json,'$.expiresAt')>${COMPUTER_DB_NOW}
        AND EXISTS(SELECT 1 FROM shared_computer_sessions s WHERE s.id=shared_computer_sessions.id AND ${computerSourceSql()})`).bind(Date.now(), id, expectedVersion, digest).run();
      if (ready.meta.changes !== 1) throw new SharedComputerError("shared_computer_creation_changed", 403);
    } catch (error) { await this.#deadline(5000, async () => container.destroy()).catch(() => {}); throw error; }
  }
  async #workspace(id: string): Promise<string> {
    const row = await this.env.AGENT_AUDIT.prepare("SELECT workspace_id FROM shared_computer_sessions WHERE id=?").bind(id).first<{ workspace_id: string }>();
    if (!row) throw new SharedComputerError("shared_computer_not_found", 404); return row.workspace_id;
  }
  async applyInput(capsule: ComputerOperation, action: SharedComputerAction): Promise<void> {
    const operation = await verifyComputerOperation(this.env, capsule, "input"), detail = operation.details;
    if (detail.operation !== "input") throw new SharedComputerError("shared_computer_operation_invalid", 403);
    const id = operation.sessionId, accountId = operation.accountId, { leaseVersion, sequence, requestId, actionHash } = detail;
    this.#bound(id); this.#assertLive(); this.#once("operation", operation.id);
    const argv = computerInputArgv(action);
    if (await hashToolArgs(action) !== actionHash) throw new SharedComputerError("shared_computer_action_hash_changed", 403);
    const row = await readComputerRow(this.env, operation.workspaceId, id), contract = computerContract(row), binding = computerBinding(row);
    if (row.version !== operation.version || row.digest !== operation.digest) throw new SharedComputerError("shared_computer_operation_version_changed", 403);
    const controller = binding.participants.find((p) => p.member.accountId === accountId && p.member.userId === operation.actorId);
    if (!controller || !contract.controllers.includes(controller.member.userId)) throw new SharedComputerError("shared_computer_controller_required", 403);
    const container = await this.#running(id, row);
    this.#once("input", requestId);
    // After all RPC/image awaits, end in one native/source/lease/command fence.
    const current = await this.env.AGENT_AUDIT.prepare(`SELECT 1 AS current FROM shared_computer_sessions s WHERE s.id=? AND s.state='running' AND s.version=? AND s.digest=?
      AND s.lease_account_id=? AND s.lease_version=? AND s.lease_expires_at>${COMPUTER_DB_NOW} AND s.sequence=? AND json_extract(s.contract_json,'$.expiresAt')>${COMPUTER_DB_NOW}
      AND EXISTS(SELECT 1 FROM shared_computer_commands c WHERE c.session_id=s.id AND c.request_id=? AND c.sequence=? AND c.action_hash=? AND c.status='claimed') AND ${computerSourceSql()}`)
      .bind(id, row.version, row.digest, accountId, leaseVersion, sequence, requestId, sequence, actionHash).first();
    if (!current) throw new SharedComputerError("shared_computer_controller_or_source_changed", 403);
    requireComputerPolicy(this.env, contract.image);
    if (Date.now() >= row.lease_expires_at || Date.now() >= contract.expiresAt || Date.now() >= operation.expiresAt) throw new SharedComputerError("shared_computer_lease_expired", 403);
    this.#assertLive();
    await this.#process(container, argv);
    const receipt = await this.env.AGENT_AUDIT.prepare("UPDATE shared_computer_commands SET status='completed' WHERE session_id=? AND request_id=? AND status='claimed'").bind(id, requestId).run();
    if (receipt.meta.changes !== 1) throw new SharedComputerError("shared_computer_input_receipt_unknown");
  }
  async captureFrame(capsule: ComputerOperation): Promise<Uint8Array> {
    const operation = await verifyComputerOperation(this.env, capsule, "capture"), id = operation.sessionId, accountId = operation.accountId;
    this.#bound(id); this.#assertLive(); this.#once("operation", operation.id);
    const row = await readComputerRow(this.env, operation.workspaceId, id), binding = computerBinding(row), contract = computerContract(row);
    if (row.version !== operation.version || row.digest !== operation.digest) throw new SharedComputerError("shared_computer_operation_version_changed", 403);
    const actor = binding.participants.find((p) => p.member.accountId === accountId && p.member.userId === operation.actorId)?.member;
    if (!actor || !contract.viewers.includes(actor.userId)) throw new SharedComputerError("shared_computer_viewer_required", 403);
    const container = await this.#running(id, row); await assertComputerCurrent(this.env, row, actor, true);
    requireComputerPolicy(this.env, contract.image);
    if (Date.now() >= operation.expiresAt) throw new SharedComputerError("shared_computer_operation_expired", 403);
    this.#assertLive();
    await this.#process(container, ["scrot", "--overwrite", "--pointer", "--quality", "60", "/tmp/shiba-computer.jpg"]);
    this.#assertLive();
    const image = await this.#deadline(5000, async (signal) => {
      const response = await new Files(container).readFile("/tmp/shiba-computer.jpg", { signal });
      const reader = response.body?.getReader(); if (!reader) throw new SharedComputerError("shared_computer_capture_unavailable", 503);
      const buffer = new Uint8Array(LIMIT.maxFrameBytes); let size = 0;
      try { for (;;) { signal.throwIfAborted(); const part = await reader.read(); if (part.done) break; if (size + part.value.byteLength > buffer.byteLength) throw new SharedComputerError("shared_computer_capture_limit", 503); buffer.set(part.value, size); size += part.value.byteLength; } }
      finally { void reader.cancel().catch(() => {}); }
      return buffer.slice(0, size);
    });
    await assertComputerCurrent(this.env, row, actor, true); requireComputerPolicy(this.env, contract.image);
    if (Date.now() >= operation.expiresAt) throw new SharedComputerError("shared_computer_operation_expired", 403);
    this.#assertLive();
    return image;
  }
  async stopSession(capsule: ComputerOperation): Promise<void> {
    const operation = await verifyComputerOperation(this.env, capsule, "stop"), id = operation.sessionId;
    this.#bound(id); this.#once("operation", operation.id);
    const row = await readComputerRow(this.env, operation.workspaceId, id), binding = computerBinding(row);
    const actor = [binding.owner, binding.funder].find((m) => m.accountId === operation.accountId && m.userId === operation.actorId);
    if (!actor || row.digest !== operation.digest || row.version !== operation.version) throw new SharedComputerError("shared_computer_stop_owner_required", 403);
    const native = nativeWorkspaceAccountSql(actor);
    if (!await this.env.AGENT_AUDIT.prepare(`SELECT 1 AS current WHERE ${native.sql}`).bind(...native.values).first()) throw new SharedComputerError("shared_computer_stop_owner_required", 403);
    if (operation.expiresAt <= Date.now()) throw new SharedComputerError("shared_computer_operation_expired", 403);
    await this.#destroy(id);
  }
  async #destroy(id: string): Promise<void> {
    // Synchronous tombstone precedes running checks, storage/network awaits and
    // capacity release. An older valid D1 read cannot allocate after STOP.
    this.#retired = true;
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO computer_once(kind,id) VALUES('retired',?)", id);
    const container = this.#bound(id);
    if (container.running) await this.#deadline(5000, async () => container.destroy());
    await this.env.AGENT_AUDIT.prepare("UPDATE shared_computer_sessions SET state='stopped',version=version+1,lease_expires_at=0,updated_at=? WHERE id=? AND state<>'stopped'").bind(Date.now(), id).run();
    await this.ctx.storage.deleteAlarm();
  }
  async alarm(): Promise<void> {
    const id = await this.ctx.storage.get<string>("session-id"); if (!id) return;
    try {
      const row = await readComputerRow(this.env, await this.#workspace(id), id); await assertComputerCurrent(this.env, row);
      if (row.state !== "starting" && row.state !== "running") throw new Error("inactive");
      await this.ctx.storage.setAlarm(Math.min(Date.now() + 1000, computerContract(row).expiresAt));
    } catch { await this.#destroy(id); }
  }
}
