export const SWARM_LANES = ["backlog", "in_progress", "needs_review", "archived"] as const;
export type SwarmLane = (typeof SWARM_LANES)[number];

export const SWARM_MODES = ["captain", "build", "review"] as const;
export type SwarmMode = (typeof SWARM_MODES)[number];

export interface SwarmRunInput {
  runId: string;
  task: string;
  repoUrl: string;
  status: "pending" | "running" | "completed" | "error" | "aborted" | "cancelled" | "unknown";
  baseBranch: string;
  pullUrl?: string;
  screenshotUrl?: string | null;
  updatedAt: number;
  createdAt: number;
  summary?: string;
  role?: "orchestrator" | "explorer" | "fixer" | "reviewer" | "designer";
}

export interface SwarmCard {
  runId: string;
  title: string;
  task: string;
  repoUrl: string;
  status: SwarmRunInput["status"];
  lane: SwarmLane;
  mode: SwarmMode;
  baseBranch: string;
  pullUrl?: string;
  screenshotUrl?: string | null;
  updatedAt: number;
}

export function laneForRun(run: Pick<SwarmRunInput, "status" | "pullUrl">): SwarmLane {
  switch (run.status) {
    case "pending":
      return "backlog";
    case "running":
      return "in_progress";
    case "completed":
      return "needs_review";
    case "error":
    case "aborted":
    case "cancelled":
    case "unknown":
      return "archived";
    default: {
      const _exhaustiveCheck: never = run.status;
      return "archived";
    }
  }
}

export function modeForRole(role: SwarmRunInput["role"]): SwarmMode {
  if (role === "orchestrator") {
    return "captain";
  }
  if (role === "reviewer") {
    return "review";
  }
  return "build";
}

export function roleForMode(mode: SwarmMode): "orchestrator" | "fixer" | "reviewer" {
  switch (mode) {
    case "captain":
      return "orchestrator";
    case "review":
      return "reviewer";
    case "build":
      return "fixer";
    default: {
      const _exhaustiveCheck: never = mode;
      return "fixer";
    }
  }
}

function cardTitleForTask(task: string): string {
  const firstLine = task.split("\n")[0]?.trim() ?? "";
  if (!firstLine) {
    return "Untitled thread";
  }
  if (firstLine.length > 80) {
    return firstLine.slice(0, 80);
  }
  return firstLine;
}

export function projectSwarmDesk(runs: readonly SwarmRunInput[]): Record<SwarmLane, SwarmCard[]> {
  const desk: Record<SwarmLane, SwarmCard[]> = {
    backlog: [],
    in_progress: [],
    needs_review: [],
    archived: [],
  };

  for (const run of runs) {
    const lane = laneForRun(run);
    const card: SwarmCard = {
      runId: run.runId,
      title: cardTitleForTask(run.task),
      task: run.task,
      repoUrl: run.repoUrl,
      status: run.status,
      lane,
      mode: modeForRole(run.role),
      baseBranch: run.baseBranch,
      pullUrl: run.pullUrl,
      screenshotUrl: run.screenshotUrl,
      updatedAt: run.updatedAt,
    };
    desk[lane].push(card);
  }

  for (const lane of SWARM_LANES) {
    desk[lane].sort((a, b) => {
      if (b.updatedAt !== a.updatedAt) {
        return b.updatedAt - a.updatedAt;
      }
      return a.runId.localeCompare(b.runId);
    });
  }

  return desk;
}

export interface SwarmIntake {
  source: "linear" | "sentry" | "plain";
  title: string;
  prompt: string;
  externalId?: string;
  url?: string;
}

export function parseSwarmIntake(text: string): SwarmIntake {
  const trimmed = text.trim();
  if (!trimmed) {
    return {
      source: "plain",
      title: "",
      prompt: "",
      externalId: undefined,
      url: undefined,
    };
  }

  // Linear issue URL: https://linear.app/<org>/issue/<KEY>-<n>/<slug> (or without slug)
  // Example: https://linear.app/myorg/issue/ENG-123/fix-the-login
  const linearUrlRegex = /^https:\/\/linear\.app\/[^/]+\/issue\/([A-Z][A-Z0-9]+-\d+)(?:\/([^/\s?#]+))?.*$/i;
  const linearUrlMatch = trimmed.match(linearUrlRegex);
  if (linearUrlMatch) {
    const key = linearUrlMatch[1] ?? "";
    const slug = linearUrlMatch[2];
    let title = key;
    if (slug) {
      const withSpaces = slug.replace(/-/g, " ");
      title = withSpaces.charAt(0).toUpperCase() + withSpaces.slice(1);
    }
    const url = trimmed;
    const prompt = `Linear ${key}: ${title}\n${url}`;
    return {
      source: "linear",
      title,
      prompt,
      externalId: key,
      url,
    };
  }

  // Bare key line: ENG-123: Fix the login (regex ^([A-Z][A-Z0-9]+-\d+):\s+(.+)$ on trimmed text, single line)
  const bareKeyRegex = /^([A-Z][A-Z0-9]+-\d+):\s+(.+)$/;
  const bareKeyMatch = trimmed.match(bareKeyRegex);
  if (bareKeyMatch && !trimmed.includes("\n")) {
    const key = bareKeyMatch[1] ?? "";
    const title = (bareKeyMatch[2] ?? "").trim();
    const prompt = `Linear ${key}: ${title}`;
    return {
      source: "linear",
      title,
      prompt,
      externalId: key,
      url: undefined,
    };
  }

  // Sentry URL whose host is sentry.io or ends with .sentry.io and whose path contains /issues/<digits>
  try {
    const parsedUrl = new URL(trimmed);
    const host = parsedUrl.hostname.toLowerCase();
    if (host === "sentry.io" || host.endsWith(".sentry.io")) {
      const issuesMatch = parsedUrl.pathname.match(/\/issues\/(\d+)/);
      if (issuesMatch) {
        const digits = issuesMatch[1] ?? "";
        const title = `Sentry issue ${digits}`;
        const prompt = `Sentry ${digits}: ${title}\n${trimmed}`;
        return {
          source: "sentry",
          title,
          prompt,
          externalId: digits,
          url: trimmed,
        };
      }
    }
  } catch {
    // Not a valid URL, ignore
  }

  // Plain
  const firstLine = trimmed.split("\n")[0]?.trim() ?? "";
  return {
    source: "plain",
    title: firstLine,
    prompt: trimmed,
    externalId: undefined,
    url: undefined,
  };
}

export function normalizeSwarmWebhook(body: unknown): SwarmIntake | null {
  if (!body || typeof body !== "object") {
    return null;
  }

  const obj = body as Record<string, unknown>;
  const data = obj["data"];

  if (data && typeof data === "object") {
    const dataObj = data as Record<string, unknown>;

    // Linear shape: object with data.identifier matching ^[A-Z][A-Z0-9]+-\d+$ and data.title a string.
    const identifier = dataObj["identifier"];
    const title = dataObj["title"];
    if (
      typeof identifier === "string" &&
      /^[A-Z][A-Z0-9]+-\d+$/.test(identifier) &&
      typeof title === "string"
    ) {
      const url = typeof dataObj["url"] === "string" ? dataObj["url"] : undefined;
      const description = typeof dataObj["description"] === "string" ? dataObj["description"] : undefined;

      let prompt = `Linear ${identifier}: ${title}`;
      if (description) {
        prompt += `\n${description}`;
      }
      if (url) {
        prompt += `\n${url}`;
      }

      return {
        source: "linear",
        title,
        prompt,
        externalId: identifier,
        url,
      };
    }

    // Else Sentry shape: object with data.issue.title a string and (data.issue.shortId or data.issue.id) a string.
    const issue = dataObj["issue"];
    if (issue && typeof issue === "object") {
      const issueObj = issue as Record<string, unknown>;
      const issueTitle = issueObj["title"];
      const shortId = issueObj["shortId"];
      const id = issueObj["id"];

      const hasShortId = typeof shortId === "string" && shortId.length > 0;
      const hasId = typeof id === "string" && id.length > 0;

      if (typeof issueTitle === "string" && (hasShortId || hasId)) {
        const externalId = hasShortId ? (shortId as string) : (id as string);
        const url = typeof issueObj["permalink"] === "string" ? (issueObj["permalink"] as string) : undefined;

        let prompt = `Sentry ${externalId}: ${issueTitle}`;
        if (url) {
          prompt += `\n${url}`;
        }

        return {
          source: "sentry",
          title: issueTitle,
          prompt,
          externalId,
          url,
        };
      }
    }
  }

  return null;
}
