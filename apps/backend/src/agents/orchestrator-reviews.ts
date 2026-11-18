import { reviewRoundWriteRejected, type ReviewRound } from "@shiba/shared";
import { RunStore } from "../runs.js";
import type { OrchestratorState } from "./orchestrator.js";

export class OrchestratorReviews {
  constructor(
    private readonly read: () => OrchestratorState,
    private readonly commit: (state: OrchestratorState) => void,
  ) {}

  write(round: ReviewRound): boolean {
    const state = this.read();
    const rounds = state.reviewRounds ?? [];
    const current = rounds.find((item) => item.roundId === round.roundId);
    if (reviewRoundWriteRejected(current, round)) return false;
    const next = {
      ...state,
      reviewRounds: current
        ? rounds.map((item) => (item.roundId === round.roundId ? round : item))
        : [...rounds, round],
    };
    const store = new RunStore(
      () => state.runs ?? [],
      (runs) => {
        next.runs = runs;
      },
    );
    const coding = store.get(round.codingRunId);
    if (coding && coding.reviewRoundId !== round.roundId)
      store.replace(round.codingRunId, { ...coding, reviewRoundId: round.roundId });
    this.commit(next);
    return true;
  }

  recover(): void {
    for (const round of this.read()?.reviewRounds ?? []) {
      if (round.publicationOutcome !== "posting") continue;
      this.write({
        ...round,
        status: "failed",
        publicationOutcome: "unknown",
        error:
          "Review publication was interrupted. Inspect GitHub before requesting another review.",
      });
    }
  }
}
