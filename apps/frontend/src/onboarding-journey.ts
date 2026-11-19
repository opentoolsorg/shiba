/**
 * The guided first-result journey: the ordered stages a new account walks
 * from a connected server to a reviewed run result.
 *
 * Every stage is derived from state the server already owns (workspace
 * membership, provider readiness, the saved onboarding draft, the run and its
 * deliverable review), so the journey resumes where the account left off after
 * a reload or a relaunch and never re-asks a satisfied stage. Nothing here
 * grants access, starts work, or stands in for the approval gate.
 */

export const JOURNEY_STEPS = ["workspace", "provider", "employee", "task", "approval", "result"] as const;
export type JourneyStepId = (typeof JOURNEY_STEPS)[number];

/** Where the first task is between "drafted" and "result visible". */
export type JourneyRunState = "none" | "awaiting-approval" | "running" | "completed" | "failed";

export interface JourneyInput {
  /** A personal or shared workspace this account can work in. */
  workspaceReady: boolean;
  /** A provider lane that can run work: a plan connection, a key, or the deployment gateway. */
  providerReady: boolean;
  /** The saved draft names a saved employee version. */
  employeeReady: boolean;
  /** The saved draft is prepared (goal, audience, acceptance, id). */
  taskPrepared: boolean;
  /** The first task's approval and run. */
  run: JourneyRunState;
  /** A human reviewed the run's deliverable. */
  activated: boolean;
  /** The account chose to leave the flow for now. */
  dismissed: boolean;
}

export type JourneyStepState = "done" | "current" | "upcoming";

export interface JourneyStep {
  id: JourneyStepId;
  label: string;
  /** What finishing this stage gets the person. */
  detail: string;
  state: JourneyStepState;
  /** What is true right now for this stage. */
  summary: string;
}

export interface JourneyStatus {
  steps: JourneyStep[];
  /** 1-based position of the current stage; steps.length when the journey is complete. */
  index: number;
  current: JourneyStepId | null;
  complete: boolean;
  /** Unfinished and not dismissed: the flow may open itself. */
  shouldPrompt: boolean;
  /** The stage a resumed flow opens on, when one is unfinished. */
  resume: JourneyStepId | null;
}

const COPY: Record<JourneyStepId, { label: string; detail: string; done: string }> = {
  workspace: {
    label: "Choose a workspace",
    detail: "Work lands in your personal workspace, or in a shared one you belong to.",
    done: "Workspace ready",
  },
  provider: {
    label: "Connect a provider",
    detail: "A plan connection, an API key, or this deployment's gateway runs the work.",
    done: "Provider ready",
  },
  employee: {
    label: "Pick an AI employee",
    detail: "A saved role with its own instructions, tools, and expected deliverables.",
    done: "Employee saved",
  },
  task: {
    label: "Draft your first task",
    detail: "Goal, audience, and what a useful result looks like.",
    done: "Task draft saved",
  },
  approval: {
    label: "Approve the run",
    detail: "Nothing runs until you approve it. The approval is yours alone.",
    done: "Run approved",
  },
  result: {
    label: "See the result",
    detail: "The run's status, files, and a review you record yourself.",
    done: "Result ready",
  },
};

function stepDone(id: JourneyStepId, input: JourneyInput): boolean {
  switch (id) {
    case "workspace":
      return input.workspaceReady;
    case "provider":
      return input.providerReady;
    case "employee":
      return input.employeeReady;
    case "task":
      return input.taskPrepared;
    case "approval":
      // Approval is granted once a run exists for the draft, whatever it ended as.
      return input.run !== "none" && input.run !== "awaiting-approval";
    case "result":
      // A finished run is not the end of setup: the person still records the
      // review, and only that completes the flow.
      return input.activated;
  }
}

function stepSummary(id: JourneyStepId, input: JourneyInput): string {
  if (stepDone(id, input)) {
    if (id === "approval" && input.run === "running") return "Approved · run in progress";
    if (id === "result") return "Result reviewed";
    return COPY[id].done;
  }
  if (id === "result" && input.run === "completed") return "Result ready · review not recorded";
  if (id === "approval" && input.run === "awaiting-approval") return "Waiting for your approval";
  if (id === "result" && input.run === "failed") return "The run failed; read its output before retrying";
  return "Not set up yet";
}

export function deriveJourney(input: JourneyInput): JourneyStatus {
  let currentSeen = false;
  const steps = JOURNEY_STEPS.map((id): JourneyStep => {
    const done = stepDone(id, input);
    const state: JourneyStepState = done ? "done" : currentSeen ? "upcoming" : "current";
    if (!done) currentSeen = true;
    return { id, ...COPY[id], state, summary: stepSummary(id, input) };
  });
  const current = steps.find((step) => step.state === "current")?.id ?? null;
  const complete = current === null;
  const index = complete ? steps.length : steps.findIndex((step) => step.state === "current") + 1;
  return {
    steps,
    index,
    current,
    complete,
    shouldPrompt: !complete && !input.dismissed,
    resume: current,
  };
}

/**
 * A returned account opens the flow by itself only while it has no result yet:
 * anyone with a settled run, a finished journey, or a dismissal is left alone
 * and reaches the flow from the reminder instead.
 */
export function shouldOpenJourney(input: {
  activated: boolean;
  dismissed: boolean;
  hasSettledRun: boolean;
}): boolean {
  return !input.activated && !input.dismissed && !input.hasSettledRun;
}
