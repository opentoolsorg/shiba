import { ReadonlySpecialistAgent } from "./readonly-agent.js";

export class ExplorerAgent extends ReadonlySpecialistAgent {
  protected readonly specialistRole = "explorer" as const;
}
