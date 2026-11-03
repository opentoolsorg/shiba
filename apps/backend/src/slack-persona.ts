/**
 * The intern's Slack voice. a coworker, not a task machine.
 *
 * One place owns how the intern talks in Slack: the voice spec below is
 * the contract, and every message the worker posts in a channel, thread,
 * or DM goes through the formatting helpers here so it reads like the
 * same teammate wrote it. Keep the register: plain, warm, concise,
 * first-person. a colleague checking in ("on it", "found the issue,
 * fixing", "done, here's the diff"), never corporate bot boilerplate
 * ("Request received", "Your task is being processed", "as an AI").
 */
import { boundTail } from "./security.js";

/**
 * The voice spec, kept as data so docs and tests can pin it. The helpers
 * in this file are the live implementation. new Slack-facing text goes
 * through them, not inline strings.
 */
export const SLACK_COWORKER_VOICE = [
  "You are AI Intern, a coworker who lives in Slack.",
  "Write like a teammate: plain, warm, concise, first-person, short sentences.",
  "Say what you are doing and what happened. 'on it', 'found it, fixing', 'done, here's the diff'.",
  "Never corporate bot boilerplate, never 'as an AI', never 'Request received'.",
  "Be honest about failure: say what broke and what you tried.",
].join(" ");

/** Slack hard-truncates long messages; stay well under that. */
export const SLACK_MAX_MESSAGE_CHARS = 3000;

export type SlackPersonaRole = "lead" | "explorer" | "fixer" | "reviewer";

export const SLACK_AGENT_PERSONAS = {
  lead: { username: "Shiba Lead", icon_emoji: ":dog:" },
  explorer: { username: "Shiba Explorer", icon_emoji: ":mag:" },
  fixer: { username: "Shiba Fixer", icon_emoji: ":hammer_and_wrench:" },
  reviewer: { username: "Shiba Reviewer", icon_emoji: ":eyes:" },
} as const satisfies Record<SlackPersonaRole, { username: string; icon_emoji: string }>;

export function slackAgentPersona(role: SlackPersonaRole = "lead"): { username: string; icon_emoji: string } {
  return SLACK_AGENT_PERSONAS[role];
}

/** `owner/repo` short form for chat; falls back to the raw string. */
export function shortRepoName(repoUrl: string): string {
  const match = /github\.com\/([^/]+\/[^/.]+?)(?:\.git)?\/?$/.exec(repoUrl.trim());
  return match?.[1] ?? repoUrl;
}

/** Human name for a coding harness id. */
export function describeHarness(harness: string | undefined): string {
  switch (harness) {
    case "claude-code":
      return "claude code";
    case "opencode":
      return "opencode";
    case "codex":
      return "codex";
    default:
      return "the coding agent";
  }
}

/** "a claude code" / "an opencode". the agent phrase for prose. */
export function agentPhrase(harness: string | undefined): string {
  const name = describeHarness(harness);
  if (name.startsWith("the ")) return name;
  return `${/^[aeiou]/i.test(name) ? "an" : "a"} ${name}`;
}

/** No repo resolved: ask in-thread, start nothing. */
export function slackAskForRepo(): string {
  return "which repo should i work in? drop the github link and i'll take it from there.";
}

/** Repo resolved but nothing to do: ask what the task is. */
export function slackAskForTask(): string {
  return "got the repo. what do you need done? a line or two is plenty.";
}

/**
 * Ack a queued task. The approval card below it carries the exact input;
 * this line is just the coworker "on it".
 */
export function slackAck(input: { repoUrl?: string; harness?: string; employeeLabel?: string }): string {
  const target = input.employeeLabel
    ? input.employeeLabel
    : input.repoUrl
      ? shortRepoName(input.repoUrl)
      : "this workspace task";
  return `on it. queued ${agentPhrase(input.harness)} run for ${target}. tap approve and i'll start.`;
}

/** Queueing itself failed before any run existed. */
export function slackQueueFailed(): string {
  return "couldn't queue that one. try again in a sec, or hit me with /shiba.";
}

/** Run admitted and the container is starting. */
export function slackRunStarted(input: { repoUrl: string; baseBranch?: string; harness?: string }): string {
  const target = input.repoUrl ? `${shortRepoName(input.repoUrl)} (${input.baseBranch ?? "main"})` : "this workspace";
  return `on it. ${describeHarness(input.harness)} is starting on ${target}. i'll post updates here.`;
}

export interface SlackRunDone {
  repoUrl: string;
  /** The coding agent's own summary, already secret-redacted. */
  summary: string;
  changedFiles?: number;
  pullUrl?: string | null;
  downloadUrl?: string | null;
  workspaceLabel?: string;
}

/** Terminal success post: what changed and where to look. */
export function slackRunCompleted(input: SlackRunDone): string {
  const target = input.workspaceLabel || (input.repoUrl ? shortRepoName(input.repoUrl) : "this workspace");
  const lines = [`done. here's what changed in ${target}:`];
  const summary = input.summary.trim();
  if (summary) {
    lines.push(boundTail(summary, 1500));
  }
  if (typeof input.changedFiles === "number") {
    lines.push(`${input.changedFiles} file${input.changedFiles === 1 ? "" : "s"} changed.`);
  }
  if (input.pullUrl) {
    lines.push(`PR: ${input.pullUrl}`);
  }
  if (input.downloadUrl) {
    lines.push(`Artifacts: ${input.downloadUrl}`);
  }
  return boundTail(lines.join("\n"), SLACK_MAX_MESSAGE_CHARS);
}

/** Terminal failure post: plain what-broke plus what it tried. */
export function slackRunFailed(input: {
  repoUrl: string;
  /** Classified user-facing explanation (run-errors wire). */
  userMessage: string;
  /** Raw error detail, truncated for the thread. */
  detail?: string;
  /** Outcome indeterminate. side effects unverified. */
  unknown?: boolean;
}): string {
  const opener = input.unknown
    ? `not sure how the ${input.repoUrl ? shortRepoName(input.repoUrl) : "workspace"} run ended`
    : `that run didn't land on ${input.repoUrl ? shortRepoName(input.repoUrl) : "this workspace"}`;
  const lines = [`${opener}. ${input.userMessage}`];
  const detail = input.detail?.trim() ?? "";
  if (detail) {
    lines.push(`what i saw: ${boundTail(detail, 800)}`);
  }
  return boundTail(lines.join("\n"), SLACK_MAX_MESSAGE_CHARS);
}

/** Human-cancelled run. */
export function slackRunCancelled(input: { repoUrl: string }): string {
  return `cancelled the ${input.repoUrl ? shortRepoName(input.repoUrl) : "workspace"} run. if a PR was mid-publish it may still land. check the repo before re-running.`;
}

export interface SlackProgressEventLike {
  phase: string;
  message: string;
}

/** One progress line in the coworker voice. */
export function slackProgressText(event: SlackProgressEventLike): string {
  const detail = boundTail(event.message.trim(), 120);
  switch (event.phase) {
    case "clone":
      return "cloning the repo";
    case "configure":
      return "setting up the workspace";
    case "collect":
      return detail ? `wrapping up. ${detail}` : "wrapping up. collecting the diff";
    default:
      return detail ? `still on it. ${detail}` : "still on it";
  }
}

/** Slack progress posts: phase beats plus a heartbeat, never a log stream. */
export const SLACK_PROGRESS_MAX_POSTS = 8;
export const SLACK_PROGRESS_HEARTBEAT_EVERY = 10;

/**
 * Throttles run progress into a Slack thread: the first event, every phase
 * transition, and every Nth "code" heartbeat. a coworker's "still on it"
 * cadence. A Slack post failure must never fail the run, so post errors
 * are swallowed here; the run transcript carries the same progress.
 */
export class SlackProgressReporter {
  private posts = 0;
  private lastPhase: string | null = null;
  private codeBeats = 0;

  constructor(
    private readonly post: (text: string, event: SlackProgressEventLike) => Promise<void>,
    private readonly maxPosts: number = SLACK_PROGRESS_MAX_POSTS,
  ) {}

  async onEvent(event: SlackProgressEventLike): Promise<void> {
    if (this.posts >= this.maxPosts) {
      return;
    }
    const first = this.lastPhase === null;
    const phaseChanged = !first && event.phase !== this.lastPhase;
    const heartbeat = event.phase === "code" && ++this.codeBeats % SLACK_PROGRESS_HEARTBEAT_EVERY === 0;
    this.lastPhase = event.phase;
    if (!(first || phaseChanged || heartbeat)) {
      return;
    }
    try {
      await this.post(slackProgressText(event), event);
      this.posts += 1;
    } catch {
      // Best-effort. the child transcript already carries the same lines.
    }
  }
}


export function slackProgressBlocks(event: SlackProgressEventLike): unknown[] {
  const current = ["clone", "configure", "code", "collect"].indexOf(event.phase);
  const steps = ["Prepare workspace", "Configure agent", "Execute task", "Collect deliverables"];
  const checklist = steps.map((step, index) => `${current > index ? "☑" : "☐"} ${step}${current === index ? " (running)" : ""}`).join("\n");
  const detail = slackProgressText(event).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return [
    { type: "section", text: { type: "mrkdwn", text: `*Run progress*\n${checklist}` } },
    { type: "context", elements: [{ type: "mrkdwn", text: detail }] },
  ];
}
