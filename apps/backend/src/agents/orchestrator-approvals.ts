import { runInputHash } from "@shiba/shared";
import {
  putCommandReceipt,
  type CommandReceipt,
  type PendingApproval,
} from "../pending-approvals.js";
import type { OrchestratorState } from "./orchestrator.js";

export class OrchestratorApprovals {
  constructor(
    private readonly read: () => OrchestratorState,
    private readonly write: (state: OrchestratorState) => void,
  ) {}

  get list(): PendingApproval[] {
    return this.read()?.pendingApprovals ?? [];
  }

  replace(pendingApprovals: PendingApproval[]): void {
    this.write({ ...this.read(), pendingApprovals });
  }

  frozenRunHash(approvalId: string): string | undefined {
    const approval = this.list.find((item) => item.approvalId === approvalId);
    if (!approval || (approval.kind !== undefined && approval.kind !== "run")) return undefined;
    return runInputHash({
      ...approval,
      baseBranch: approval.baseBranch ?? "main",
      publishPullRequest: approval.publishPullRequest ?? false,
    });
  }

  receipt(commandId: string): CommandReceipt | undefined {
    return this.read()?.commandReceipts?.[commandId];
  }

  withReceipt(receipt: CommandReceipt): Record<string, CommandReceipt> {
    return putCommandReceipt(this.read()?.commandReceipts ?? {}, receipt);
  }

  recordReceipt(receipt: CommandReceipt): void {
    this.write({ ...this.read(), commandReceipts: this.withReceipt(receipt) });
  }
}
