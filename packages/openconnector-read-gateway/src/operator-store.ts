import { OperatorGateError, type OperatorExecutionEnvelope } from "./operator-envelope.js";

/** Structural Durable Object SQLite subset. All authority transitions are synchronous transactions. */
export type OperatorSqlValue = string | number | null | ArrayBuffer;
export interface OperatorSqlStorage {
  sql: { exec<T extends Record<string, OperatorSqlValue> = Record<string, OperatorSqlValue>>(query: string, ...bindings: (string | number | null)[]): Iterable<T> };
  transactionSync<T>(callback: () => T): T;
  sync(): Promise<void>;
}
export type OperatorOutcome = "claimed" | "admitted" | "dispatch_committed" | "completed" | "rejected_before_admission" | "unknown" | "receipt_pruned";
export interface OperatorReceipt {
  invocationId: string; requestDigest: string; state: OperatorOutcome; code: string;
  effectiveDeadline?: number; result?: { name: string; lastTouchedAt: string };
}
interface InvocationRow extends Record<string, OperatorSqlValue> { invocation_id: string; digest: string; approval_id: string; state: OperatorOutcome; receipt: string }
const active = ["claimed", "admitted", "dispatch_committed"];
/** Never uses TTL deletion. Approval and invocation tombstones survive response pruning and epoch changes. */
export class OperatorInvocationStore {
  constructor(private readonly storage: OperatorSqlStorage) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS shiba_operator_invocations (
      invocation_id TEXT PRIMARY KEY, digest TEXT NOT NULL, approval_id TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL, receipt TEXT NOT NULL)`);
    storage.sql.exec("CREATE TABLE IF NOT EXISTS shiba_operator_epoch (id INTEGER PRIMARY KEY CHECK(id=1), epoch TEXT NOT NULL, state TEXT NOT NULL)");
  }
  /** Call once during DO construction, before accepting any request. An interrupted call is never resumed. */
  recover(): void {
    this.storage.transactionSync(() => {
      for (const row of this.storage.sql.exec<InvocationRow>("SELECT * FROM shiba_operator_invocations WHERE state IN ('claimed','admitted','dispatch_committed')")) {
        this.write({ invocationId: row.invocation_id, requestDigest: row.digest, state: "unknown", code: "operator_process_interrupted" });
      }
    });
  }
  flush(): Promise<void> { return this.storage.sync(); }
  epoch(): { epoch: string; state: string } | undefined {
    const row = [...this.storage.sql.exec<{ epoch: string; state: string }>("SELECT epoch,state FROM shiba_operator_epoch WHERE id=1")][0];
    return row && { epoch: row.epoch, state: row.state };
  }
  /** Internal setup only. Not an HTTP admin route and not evidence that external writers have drained. */
  initializeEpoch(epoch: string): void {
    this.storage.transactionSync(() => {
      const existing = this.epoch();
      if (existing && (existing.epoch !== epoch || existing.state !== "active")) throw new OperatorGateError("operator_epoch_unavailable", 503);
      if (!existing) this.storage.sql.exec("INSERT INTO shiba_operator_epoch VALUES(1,?,'active')", epoch);
    });
  }
  retireEpoch(epoch: string): void {
    this.storage.transactionSync(() => { this.assertEpoch(epoch); this.storage.sql.exec("UPDATE shiba_operator_epoch SET state='retired' WHERE id=1"); });
  }
  /** A retired owner cannot reactivate itself. Cutover needs a reviewed migration, not an expiry lease. */
  assertEpoch(epoch: string): void {
    const current = this.epoch(); if (!current || current.epoch !== epoch || current.state !== "active") throw new OperatorGateError("operator_epoch_unavailable", 503);
  }
  lookup(invocationId: string, digest: string): OperatorReceipt | undefined {
    const row = [...this.storage.sql.exec<InvocationRow>("SELECT * FROM shiba_operator_invocations WHERE invocation_id=?", invocationId)][0];
    if (!row) return undefined;
    if (row.digest !== digest) throw new OperatorGateError("operator_invocation_conflict", 409);
    return JSON.parse(row.receipt) as OperatorReceipt;
  }
  claim(envelope: OperatorExecutionEnvelope): { acquired: boolean; receipt: OperatorReceipt } {
    return this.storage.transactionSync(() => {
      this.assertEpoch(envelope.deploymentEpoch);
      const prior = this.lookup(envelope.invocationId, envelope.requestDigest); if (prior) return { acquired: false, receipt: prior };
      if ([...this.storage.sql.exec("SELECT invocation_id FROM shiba_operator_invocations WHERE approval_id=?", envelope.approvalId)].length) throw new OperatorGateError("operator_approval_consumed", 409);
      const receipt: OperatorReceipt = { invocationId: envelope.invocationId, requestDigest: envelope.requestDigest, state: "claimed", code: "operator_in_progress" };
      this.storage.sql.exec("INSERT INTO shiba_operator_invocations VALUES(?,?,?,?,?)", envelope.invocationId, envelope.requestDigest, envelope.approvalId, receipt.state, JSON.stringify(receipt));
      return { acquired: true, receipt };
    });
  }
  transition(receipt: OperatorReceipt): OperatorReceipt {
    return this.storage.transactionSync(() => {
      const prior = this.lookup(receipt.invocationId, receipt.requestDigest);
      const valid = prior && ((prior.state === "claimed" && ["admitted", "rejected_before_admission", "unknown"].includes(receipt.state)) ||
        (prior.state === "admitted" && ["dispatch_committed", "unknown"].includes(receipt.state)) ||
        (prior.state === "dispatch_committed" && ["completed", "unknown"].includes(receipt.state)) ||
        (prior.state === "completed" && receipt.state === "receipt_pruned"));
      if (!valid) throw new OperatorGateError("operator_transition_invalid", 409);
      this.write(receipt); return receipt;
    });
  }
  unknown(invocationId: string, requestDigest: string, code = "operator_outcome_unknown"): OperatorReceipt {
    const prior = this.lookup(invocationId, requestDigest);
    if (!prior) throw new OperatorGateError("operator_invocation_missing", 409);
    return active.includes(prior.state) ? this.transition({ invocationId, requestDigest, state: "unknown", code }) : prior;
  }
  prune(invocationId: string, requestDigest: string): OperatorReceipt {
    return this.transition({ invocationId, requestDigest, state: "receipt_pruned", code: "operator_receipt_pruned" });
  }
  private write(receipt: OperatorReceipt): void {
    this.storage.sql.exec("UPDATE shiba_operator_invocations SET state=?,receipt=? WHERE invocation_id=? AND digest=?", receipt.state, JSON.stringify(receipt), receipt.invocationId, receipt.requestDigest);
  }
}
