import { abortable } from "./json.js";
import type { CoordinatedOwner } from "./coordinated-owner.js";
import { OperatorGateError, parseOperatorEnvelope, type OperatorExecutionEnvelope } from "./operator-envelope.js";
import type { OperatorInvocationStore, OperatorReceipt } from "./operator-store.js";
import type { PreparedOperatorRequest } from "./operator-provider.js";

export interface OperatorParentAuthority {
  redeem(input: { envelope: OperatorExecutionEnvelope; requestDigest: string; capability: string; tokenExpiresAt: number }): Promise<
    { status: "admitted"; effectiveDeadline: number } | { status: "rejected" | "unknown" }>;
}
export interface OperatorGatewayDependencies {
  owner: CoordinatedOwner; store: OperatorInvocationStore;
  deploymentEpoch: string; versionId: string; manifestDigest: string;
  parent: OperatorParentAuthority;
  /** Called ONLY under the same owner as every native mutation. Must authenticate stored scoped tokens first. */
  capture(input: OperatorExecutionEnvelope, runtimeToken: string): Promise<{ request: PreparedOperatorRequest; tokenExpiresAt: number }>;
  now?: () => number;
}
/** Internal runtime, intentionally not registered in the production Worker or exposed by a feature flag. */
export class OperatorGateway {
  private readonly now: () => number;
  constructor(private readonly dependencies: OperatorGatewayDependencies) { this.now = dependencies.now ?? Date.now; }
  execute(value: unknown, runtimeToken: string, capability: string, cancellation?: AbortSignal): Promise<OperatorReceipt> {
    return this.dependencies.owner.run(async () => {
      const input = await parseOperatorEnvelope(value), { store } = this.dependencies;
      if (!/^oct_[A-Za-z0-9_-]{43}$/.test(runtimeToken) || !/^[A-Za-z0-9_.-]{1,4096}$/.test(capability)) throw new OperatorGateError("operator_scoped_authority_required");
      if (input.deploymentEpoch !== this.dependencies.deploymentEpoch || input.versionId !== this.dependencies.versionId || input.manifestDigest !== this.dependencies.manifestDigest) throw new OperatorGateError("operator_deployment_mismatch", 409);
      store.assertEpoch(input.deploymentEpoch);
      // Expired replays may return their permanent receipt, but can never claim or dispatch again.
      const captured = await this.dependencies.capture(input, runtimeToken);
      const prior = store.lookup(input.invocationId, input.requestDigest); if (prior) return prior;
      if (cancellation?.aborted || input.expiresAt <= this.now() || input.expiresAt > this.now() + 60000 || !Number.isSafeInteger(captured.tokenExpiresAt) || captured.tokenExpiresAt <= this.now()) throw new OperatorGateError("operator_deadline_expired", 409);
      const claimed = store.claim(input); if (!claimed.acquired) return claimed.receipt;
      const base = { invocationId: input.invocationId, requestDigest: input.requestDigest };
      try {
        await store.flush();
        if (cancellation?.aborted || input.expiresAt <= this.now() || captured.tokenExpiresAt <= this.now()) {
          const receipt = store.transition({ ...base, state: "rejected_before_admission", code: "operator_deadline_expired" }); await store.flush(); return receipt;
        }
        const admission = await abortable(this.dependencies.parent.redeem({ envelope: input, requestDigest: input.requestDigest, capability, tokenExpiresAt: captured.tokenExpiresAt }), AbortSignal.timeout(Math.min(5000, input.expiresAt - this.now())));
        if (admission.status === "rejected") { const receipt = store.transition({ ...base, state: "rejected_before_admission", code: "operator_parent_rejected" }); await store.flush(); return receipt; }
        if (admission.status !== "admitted") throw new OperatorGateError("operator_admission_unknown", 503);
        const deadline = admission.effectiveDeadline;
        if (!Number.isSafeInteger(deadline) || deadline > input.expiresAt || deadline > captured.tokenExpiresAt) throw new OperatorGateError("operator_admission_invalid", 503);
        store.transition({ ...base, state: "admitted", code: "operator_in_progress", effectiveDeadline: deadline }); await store.flush();
        store.transition({ ...base, state: "dispatch_committed", code: "operator_in_progress", effectiveDeadline: deadline }); await store.flush();
        // Last fence AFTER the last awaited durable commit. No asynchronous work before send().
        store.assertEpoch(input.deploymentEpoch);
        if (cancellation?.aborted || deadline <= this.now()) throw new OperatorGateError("operator_deadline_expired", 409);
        const timeout = AbortSignal.timeout(Math.min(input.maxDurationMs, deadline - this.now()));
        const signal = cancellation ? AbortSignal.any([cancellation, timeout]) : timeout;
        signal.throwIfAborted();
        const response = await abortable(captured.request.send(signal), signal);
        const result = await abortable(captured.request.project(response, signal), signal);
        const receipt = store.transition({ ...base, state: "completed", code: "operator_completed", effectiveDeadline: deadline, result });
        await store.flush(); return receipt;
      } catch {
        // No raw exception, upstream auth error, secret or payload is returned or logged.
        // If persistence itself fails, the caller sees an unavailable result; recovery never resumes claims.
        const receipt = store.unknown(input.invocationId, input.requestDigest);
        await store.flush(); return receipt;
      }
    });
  }
  barrier(input: { deploymentEpoch: string; revocationId: string }): Promise<{ deploymentEpoch: string; revocationId: string; status: "complete" }> {
    return this.dependencies.owner.run(async () => {
      this.dependencies.store.assertEpoch(input.deploymentEpoch);
      if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(input.revocationId)) throw new OperatorGateError("operator_barrier_invalid", 400);
      await this.dependencies.store.flush();
      return { ...input, status: "complete" };
    });
  }
}
