import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  workspaceVerified: true,
  agent: {
    connectionError: null,
    identified: true,
  },
  chat: {
    messages: [] as Array<{ id: string; role: string; parts: unknown[] }>,
    error: null as Error | null,
    isStreaming: false,
    status: "ready",
    sendMessage: vi.fn(),
    clearHistory: vi.fn(),
    addToolApprovalResponse: vi.fn(),
  },
  runsById: {} as Record<string, unknown>,
}));

vi.mock("agents/react", () => ({
  useAgent: () => mocks.agent,
  useAgentToolEvents: () => ({ runsById: mocks.runsById }),
}));
// These static fixtures represent a fully verified personal workspace. Real
// authentication and workspace resolution run asynchronously in the browser.
vi.mock("../../frontend/src/team-workspaces-client", async (original) => ({
  ...await original<typeof import("../../frontend/src/team-workspaces-client")>(),
  useTeamWorkspaceDirectory: () => ({ verified: mocks.workspaceVerified, loading: !mocks.workspaceVerified,
    error: null, selectedWorkspaceId: "", workspaces: [], selectWorkspace: vi.fn(), refresh: vi.fn(async () => {}) }),
}));

vi.mock("@cloudflare/ai-chat/react", () => ({
  useAgentChat: () => mocks.chat,
  getToolApproval: (part: { approvalId?: string }) =>
    part.approvalId ? { id: part.approvalId } : undefined,
  getToolCallId: (part: { toolCallId?: string }) => part.toolCallId ?? "call",
  getToolInput: (part: { input?: unknown }) => part.input,
  getToolPartState: (part: { state?: string }) => part.state,
}));

vi.mock("ai", () => ({
  isToolUIPart: (part: { type?: unknown }) =>
    typeof part.type === "string" && part.type.startsWith("tool-"),
}));

import { App } from "../../frontend/src/app";
import { AnalyticsView } from "../../frontend/src/components/AnalyticsView";
import { AutomationsView } from "../../frontend/src/components/AutomationsView";
import { DashboardView } from "../../frontend/src/components/DashboardView";
import { DiffView } from "../../frontend/src/components/DiffView";
import { ApprovalsView } from "../../frontend/src/components/ApprovalsView";
import { OnboardingModal, ONBOARDING_STEPS } from "../../frontend/src/components/OnboardingModal";
import { TaskForm } from "../../web/src/components/TaskForm";
import { Tooltip } from "../../frontend/src/components/Tooltip";

afterEach(() => {
  mocks.workspaceVerified = true;
  delete (globalThis as { __shibaTestAgent?: string }).__shibaTestAgent;
  mocks.chat.messages = [];
  mocks.chat.error = null;
  mocks.chat.isStreaming = false;
  mocks.chat.status = "ready";
  mocks.runsById = {};
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function renderApp(view?: "threads", mode: "chat" | "work" = "chat") {
  (globalThis as { __shibaTestAgent?: string }).__shibaTestAgent = "ada@example.com";
  if (view) {
    vi.stubGlobal("window", { location: new URL(`https://app.tryshiba.dev/${view}/`) });
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => key === "shiba:conversation-mode:default" ? mode : null,
    });
  }
  return renderToStaticMarkup(React.createElement(App));
}

describe("dashboard rendering", () => {
  it("does not render personal conversation data before workspace verification", () => {
    mocks.workspaceVerified = false;
    const markup = renderApp("threads", "work");
    expect(markup).toContain("Checking workspace access");
    expect(markup).not.toContain('data-testid="task-composer"');
  });
  it("renders the dashboard overview and links to real capability surfaces", () => {
    const markup = renderToStaticMarkup(React.createElement(DashboardView, {
      runs: [],
      pendingApprovals: [],
      storedApprovals: [],
      agents: [],
      connectionLabel: "Connected",
      connectionTone: "ok",
      runsError: null,
      onNavigate: vi.fn(),
      onNewTask: vi.fn(),
      onInspectRun: vi.fn(),
    }));

    expect(markup).toContain("Your agent plane");
    expect(markup).toContain("Agents &amp; MCP");
    expect(markup).toContain("Mailbox");
    expect(markup).toContain("Memory");
    expect(markup).toContain("Sandbox");
    expect(markup).toContain("No runs yet");
  });

  it("shows useful empty states when no task has started", () => {
    const markup = renderApp();

    expect(markup).toContain('aria-label="Work views"');
    expect(markup).toContain('aria-label="Add a task and press Enter"');
    expect(markup).toContain("Nothing needs you");
    expect(markup).toContain("Nothing assigned to you");
    expect(markup).toContain("No open tasks");
    expect(markup).toContain("New task");
    expect(markup).toContain('aria-label="Chats"');
  });

  it("shows the task composer when Threads has a saved Work mode preference", () => {
    const markup = renderApp("threads", "work");

    expect(markup).toContain('data-testid="task-composer"');
    expect(markup).toContain('aria-label="Task description"');
    expect(markup).toContain("What do you want to get done?");
    expect(markup).toContain('aria-label="Thread configuration"');
  });

  it("renders a pending approval with its tool input and actions", () => {
    mocks.chat.messages = [
      {
        id: "message-1",
        role: "assistant",
        parts: [
          {
            type: "tool-runSandbox",
            state: "waiting-approval",
            approvalId: "approval-1",
            toolCallId: "call-1",
            input: { command: "npm test" },
          },
        ],
      },
    ];

    const workMarkup = renderApp();
    expect(workMarkup).toContain("Approve tool: runSandbox");
    expect(workMarkup).toContain("Review");

    const markup = renderApp("threads");

    expect(markup).toContain("Waiting for your approval");
    expect(markup).toContain("Needs approval");
    expect(markup).toContain("runSandbox");
    expect(markup).toContain("&quot;command&quot;: &quot;npm test&quot;");
    expect(markup).toContain("Approve");
    expect(markup).toContain("Reject");
  });

  it("renders chat errors and live run output without hiding the run state", () => {
    mocks.chat.error = new Error("stream failed");
    mocks.runsById = {
      "run-1": {
        runId: "run-1",
        status: "error",
        agentType: "coding-agent",
        parentToolCallId: "call-1",
        parts: [{ text: "sandbox failed" }],
        summary: "The sandbox exited early.",
        error: "exit code 1",
      },
    };

    const markup = renderApp("threads");

    expect(markup).toContain("Chat error: stream failed");
    expect(markup).toContain("run-1");

  });

  it("renders task submission form", () => {
    const formMarkup = renderToStaticMarkup(React.createElement(TaskForm));

    expect(formMarkup).toContain('data-testid="task-submission-form"');
    expect(formMarkup).toContain('type="url"');
    expect(formMarkup).toContain("required");
    expect(formMarkup).toContain("<textarea");
    expect(formMarkup).toContain('type="checkbox"');
    expect(formMarkup).toContain('value="main"');

    const appMarkup = renderApp("threads", "work");

    expect(appMarkup).toContain('data-testid="task-composer"');
    expect(appMarkup).toContain("<textarea");
    expect(appMarkup).toContain('aria-label="Thread configuration"');
  });

  it("renders diff output for completed runs in standalone DiffView", () => {
    const run = {
      runId: "run-diff-1",
      sandboxId: "sb-diff-1",
      repoUrl: "https://github.com/owner/repo",
      task: "Implement feature",
      baseBranch: "main",
      publishPullRequest: false,
      status: "completed" as const,
      createdAt: Date.now() - 10000,
      updatedAt: Date.now(),
      agentType: "coding-agent",
      parentToolCallId: "call-1",
      parts: [{ text: "done" }],
      summary: "Done.",
      diff: "diff --git a/src/a.ts b/src/a.ts\n+added line\n-removed line",
    };

    const diffMarkup = renderToStaticMarkup(
      React.createElement(DiffView, {
        runs: [run],
        selectedRunId: "run-diff-1",
      })
    );

    expect(diffMarkup).toContain("run-diff-1");
    expect(diffMarkup).toContain("Completed");
    expect(diffMarkup).toContain("diff --git");
    expect(diffMarkup).toContain("added line");
    expect(diffMarkup).toContain("removed line");
    expect(diffMarkup).toContain("<pre");
    expect(diffMarkup).toContain("<code");
  });

  it("renders the top navigation bar without the retired Architecture view", () => {
    const markup = renderApp();
    expect(markup).toContain("New task");
    expect(markup).toContain('aria-label="Chats"');
    expect(markup).toContain('aria-label="Agents"');
    expect(markup).toContain('aria-label="More"');
    expect(markup).toContain('aria-label="Settings"');
    expect(markup).not.toContain("Architecture");
    // Deduped surfaces stay deep-link reachable but are out of the nav.
    expect(markup).not.toContain("Missions &amp; Standing Goals");
    expect(markup).not.toContain("Review, QA &amp; Security Gates");
    expect(markup).not.toContain("VM Inspector &amp; Terminals");
    expect(markup).not.toContain("Usage, Costs &amp; Run Metrics");
  });

  it("renders standalone DiffView and ApprovalsView with empty states", () => {
    const diffMarkup = renderToStaticMarkup(
      React.createElement(DiffView, {
        runs: [],
      })
    );
    expect(diffMarkup).toContain("Pull requests");
    expect(diffMarkup).toContain("No runs yet");
    expect(diffMarkup).toContain("0 with diffs / 0 total");
    expect(diffMarkup).not.toContain('aria-label="Select run for diff inspection"');

    const approvalsMarkup = renderToStaticMarkup(
      React.createElement(ApprovalsView, {
        pendingApprovals: [],
        decisions: {},
        onDecideApproval: vi.fn(),
        storedApprovals: [],
        storedDecisions: {},
        decidedStoredApprovals: [],
        storedApprovalsError: null,
        onDecideStoredApproval: vi.fn(),
      })
    );
    expect(approvalsMarkup).toContain("Approvals");
    expect(approvalsMarkup).toContain("Nothing needs you");
    expect(approvalsMarkup).toContain("0 open");
    expect(approvalsMarkup).toContain("Audit log");
    expect(approvalsMarkup).not.toContain("Zero-Trust");
  });




  it("renders AnalyticsView with the run table", () => {
    const runs = [
      {
        runId: "run-reg-1",
        sandboxId: "sb-1",
        repoUrl: "https://github.com/owner/repo",
        task: "Fix bug",
        baseBranch: "main",
        publishPullRequest: true,
        generation: 0,
        status: "completed" as const,
        createdAt: Date.now() - 30000,
        updatedAt: Date.now(),
      },
    ];
    const markup = renderToStaticMarkup(React.createElement(AnalyticsView, {
      runs,
      sessionId: "default",
      sessionApiAvailable: false,
    }));
    expect(markup).toContain("Usage");
    expect(markup).toContain("Fix bug");
    expect(markup).toContain("owner/repo");
  });

  it("renders AutomationsView with navigation to recipes and inbound triggers", () => {
    const markup = renderToStaticMarkup(React.createElement(AutomationsView));
    expect(markup).toContain("Automations");
    expect(markup).toContain('aria-label="Automation views"');
    expect(markup).toContain(">Recipes</button>");
    expect(markup).toContain(">Triggers</button>");
    expect(markup).toContain("New automation");
    expect(markup).toContain('aria-label="Deployed automations"');
    expect(markup).toContain("All runs require your approval.");
  });

  it("renders OnboardingModal with steps from PLAN.md", () => {
    expect(ONBOARDING_STEPS.length).toBe(6);
    const markup = renderToStaticMarkup(React.createElement(OnboardingModal, {
      isOpen: true,
      onClose: () => {},
      onSelectStarterTask: () => {},
    }));
    expect(markup).toContain("Quick Setup &amp; Onboarding");
    expect(markup).toContain("Connect GitHub");
    expect(markup).toContain("Connect Sandbox Runner");
    expect(markup).toContain("Connect Model Keys");
    expect(markup).toContain("Operator &amp; Self-Hosting Setup");
    expect(markup).toContain('role="checkbox"');
  });
  it("renders the sidebar toggle, search, and thread group controls", () => {
    const markup = renderApp();
    expect(markup).toContain('aria-label="Collapse sidebar"');
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('aria-label="Search tasks"');
    expect(markup).toContain('aria-label="Chats"');
  });

  it("renders Tooltip component wrapping trigger elements", () => {
    const tooltipMarkup = renderToStaticMarkup(
      React.createElement(
        Tooltip,
        {
          content: "Test Tooltip Content",
          shortcut: "⌘T",
          children: React.createElement("button", { type: "button" }, "Hover Me"),
        }
      )
    );
    expect(tooltipMarkup).toContain("<button");
    expect(tooltipMarkup).toContain("Hover Me");
  });
});
