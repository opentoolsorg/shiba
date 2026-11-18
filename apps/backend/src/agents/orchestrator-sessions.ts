import { pruneExpiredWebSessions, type WebSessionRecord } from "../web-sessions.js";
import type { OrchestratorState } from "./orchestrator.js";

export class OrchestratorSessions {
  constructor(
    private readonly read: () => OrchestratorState,
    private readonly write: (state: OrchestratorState) => void,
  ) {}

  get list(): WebSessionRecord[] {
    return this.read()?.webSessions ?? [];
  }

  replace(webSessions: WebSessionRecord[]): void {
    this.write({ ...(this.read() ?? { runs: [] }), webSessions });
  }

  prune(now: number): void {
    const current = this.list;
    const pruned = pruneExpiredWebSessions(current, now);
    if (pruned.length !== current.length) this.replace(pruned);
  }
}
