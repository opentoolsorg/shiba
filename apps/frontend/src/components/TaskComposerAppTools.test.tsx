// @vitest-environment happy-dom
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appToolsWorkIssue, sendAppToolsWork, type AppToolsWorkContext } from "../app-tools-work";
import { TaskComposer } from "./TaskComposer";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const context = {
  sessionId: "employee-session", sessionAvailable: true, employeeId: "research",
  session: { id: "employee-session", name: "Research", agentName: "web:owner:employee-session", updatedAt: 1, metadata: { customAgentId: "research" } },
  profile: { id: "research", slug: "research", version: 1, config: { name: "Research", instructions: "Use the selected sources.", harness: "opencode", toolScopes: ["mcp:shiba:gmail_read"], defaultRepoUrl: "https://github.com/example/unused" } },
  profilesUnavailable: false, socketName: "web:owner:employee-session", connected: true,
} satisfies AppToolsWorkContext;

function Harness({ binding = context, sendMessage, submitting = false }: {
  binding?: AppToolsWorkContext;
  sendMessage: Parameters<typeof sendAppToolsWork>[2];
  submitting?: boolean;
}) {
  const [appToolsWork, setAppToolsWork] = useState(false);
  const [task, setTask] = useState("Summarize the granted Gmail message and retain a draft.");
  return <TaskComposer appToolsWork={appToolsWork} onAppToolsWorkChange={setAppToolsWork}
    appToolsWorkIssue={appToolsWorkIssue(binding)} repoUrl="" task={task} baseBranch="main"
    executionTargetKind="artifact-workspace" artifactDeliverables="" runTarget="local" localRunAvailable={false}
    publishPullRequest={false} harness="opencode" busy={false} isSubmitting={submitting} clearing={false}
    customAgentId="research" customAgents={[{ id: "research", slug: "research", name: "Research" }]}
    routing={{ codingModel: "", connectionId: "", onCodingModelChange: vi.fn(), onConnectionChange: vi.fn(), reasoningEffort: "", onReasoningEffortChange: vi.fn() }}
    onRepoUrlChange={vi.fn()} onTaskChange={setTask} onBaseBranchChange={vi.fn()} onPublishPullRequestChange={vi.fn()}
    onHarnessChange={vi.fn()} onClear={vi.fn()} onSubmit={() => { void sendAppToolsWork(binding, task, sendMessage); }} />;
}

const chooseAppTools = () => fireEvent.change(screen.getByRole("combobox", { name: "Work target" }), { target: { value: "app-tools" } });

describe("explicit Worker app-tools Work path", () => {
  it("carries only a validated goal reference beside the exact app-tools marker", async () => {
    const sendMessage = vi.fn(async () => {});
    const reference = { draftTaskId: "draft_00000000-0000-4000-8000-000000000001", version: 2 };
    await sendAppToolsWork(context, "Canonical prepared brief", sendMessage, reference);
    expect(sendMessage).toHaveBeenCalledWith({ text: "Canonical prepared brief", metadata: { shibaMode: "work", shibaWorkTarget: "app-tools", shibaDraftTaskId: reference.draftTaskId, shibaDraftTaskVersion: 2 } });
    await expect(sendAppToolsWork(context, "brief", sendMessage, { draftTaskId: "foreign", version: 2 })).rejects.toMatchObject({ message: "Review the saved first task draft before sending." });
    expect(sendMessage).toHaveBeenCalledOnce();
  });
  it("sends one server-bound employee turn without a repository, artifact paths, or computer request", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const sendMessage = vi.fn(async () => {});
    render(<Harness sendMessage={sendMessage} />);
    chooseAppTools();
    expect(screen.queryByRole("button", { name: /Run on:|Project:/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Send task" }).hasAttribute("disabled")).toBe(false);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Task description" }), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(sendMessage).toHaveBeenCalledExactlyOnceWith({
      text: "Summarize the granted Gmail message and retain a draft.", metadata: { shibaMode: "work", shibaWorkTarget: "app-tools" },
    }));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { name: "unbound session", change: { session: { ...context.session, metadata: { customAgentId: "other" } } } },
    { name: "default session", change: { sessionId: "default" } },
    { name: "unverified session registry", change: { sessionAvailable: false } },
    { name: "previous socket", change: { socketName: "web:owner:previous-session" } },
    { name: "offline socket", change: { connected: false } },
    { name: "unavailable profiles", change: { profilesUnavailable: true } },
    { name: "selected employee mismatch", change: { employeeId: "other" } },
    { name: "unmanaged employee", change: { profile: { ...context.profile, config: { ...context.profile.config, toolScopes: undefined } } } },
    { name: "revoked app scopes", change: { profile: { ...context.profile, config: { ...context.profile.config, toolScopes: [] } } } },
  ])("denies $name without switching to a computer or sending a message", async ({ change }) => {
    const sendMessage = vi.fn(async () => {});
    const binding = { ...context, ...change };
    render(<Harness binding={binding} sendMessage={sendMessage} />);
    chooseAppTools();
    expect(screen.getByRole("button", { name: "Send task" }).hasAttribute("disabled")).toBe(true);
    fireEvent.submit(screen.getByRole("form", { name: "Connected app task composer" }));
    await expect(sendAppToolsWork(binding, "Draft a brief", sendMessage)).rejects.toThrow();
    expect(sendMessage).not.toHaveBeenCalled();
    expect((screen.getByRole("combobox", { name: "Work target" }) as HTMLSelectElement).value).toBe("app-tools");
    expect((screen.getByRole("textbox", { name: "Task description" }) as HTMLTextAreaElement).value).toContain("granted Gmail message");
  });

  it("rejects an empty task before touching the message transport", async () => {
    const sendMessage = vi.fn(async () => {});
    await expect(sendAppToolsWork(context, "  ", sendMessage)).rejects.toMatchObject({ message: "Enter a task first." });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("blocks keyboard resubmission while the prior send is pending", () => {
    const sendMessage = vi.fn(async () => {});
    const view = render(<Harness sendMessage={sendMessage} />);
    chooseAppTools();
    view.rerender(<Harness sendMessage={sendMessage} submitting />);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Task description" }), { key: "Enter", ctrlKey: true });
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
