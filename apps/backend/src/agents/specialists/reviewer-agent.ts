import { ReadonlySpecialistAgent } from "./readonly-agent.js";

export class ReviewerAgent extends ReadonlySpecialistAgent {
  protected readonly specialistRole = "reviewer" as const;
}
