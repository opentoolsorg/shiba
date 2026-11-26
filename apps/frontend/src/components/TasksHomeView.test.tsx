// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { buildTasksHomeBuckets, TasksHomeView } from "./TasksHomeView";
import type { RetainedRun, StoredApproval } from "../types";

const setupState: { current: unknown } = { current: { kind: "loading" } };
vi.mock("../live-status", () => ({useSetupStatus: () => ({state: setupState.current, reload: vi.fn(), inFlight: false})}));
beforeEach(() => { vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(Response.json({})))); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function show(overrides: Partial<React.ComponentProps<typeof TasksHomeView>> = {}) {
  return render(<TasksHomeView task="Fix the bug" onTaskChange={vi.fn()} agents={[]} selectedAgentId="" onAgentChange={vi.fn()} repoUrl="owner/repo" onRepoUrlChange={vi.fn()} runs={[]} approvals={[]} route={{runTarget: "local"}} onSubmit={vi.fn()} {...overrides} />);
}
describe("task handoff", () => {
  it("places completed runs in Recently answered without dropping approval decisions", () => {
    const run = { runId: "done", task: "Finished work", repoUrl: "https://github.com/a/b", status: "completed", createdAt: 1, updatedAt: 2 } as RetainedRun;
    const approval: StoredApproval = { approvalId: "p", threadKey: "t", repoUrl: "", task: "Approve publication", status: "pending", createdAt: 3, kind: "pr_publish" };
    const buckets = buildTasksHomeBuckets([run], [approval]);
    expect(buckets.recentlyAnswered.map((item) => item.title)).toEqual(["Finished work"]);
    expect(buckets.needsYou.map((item) => item.title)).toContain("Approve publication");
    show({ runs: [run], approvals: [approval], route: { runTarget: "sandbox" } });
    expect(screen.getByRole("region", { name: "Recently answered" }).textContent).toContain("Finished work");
    expect(screen.getByRole("region", { name: "Needs you" }).textContent).toContain("Approve publication");
  });

  it("shows chat approvals on home and deduplicates stored approvals by id", () => {
    const onOpenApproval = vi.fn();
    const approval: StoredApproval = {
      threadKey: "thread-1", approvalId: "shared-id", task: "Review deployment",
      repoUrl: "https://github.com/acme/app", status: "pending", createdAt: Date.now(), payload: {},
    };
    show({
      approvals: [approval],
      pendingApprovals: [
        { messageId: "message-1", toolCallId: "tool-1", approvalId: "shared-id", tool: "shell", input: {} },
        { messageId: "message-2", toolCallId: "tool-2", approvalId: "chat-only", tool: "writeFile", input: {} },
      ],
      onOpenApproval,
    });
    expect(screen.getAllByTestId("task-row-approval:shared-id")).toHaveLength(1);
    expect(screen.getByTestId("task-row-approval:chat-only").textContent).toContain("Approve tool: writeFile");
    fireEvent.click(screen.getByRole("button", { name: "Approve tool: writeFile" }));
    expect(onOpenApproval).toHaveBeenCalledWith("chat-only");
  });
  it("renders exactly one ModelRouteCard when setup needs a provider", () => {
    setupState.current = { kind: "data", data: { modelRoute: { provider: "test", model: "model", status: "ready" } } };
    show({ route: { runTarget: "sandbox" } });
    expect(screen.getAllByTestId("model-route-card")).toHaveLength(1);
    setupState.current = { kind: "loading" };
  });
  it("announces backend rejection or early validation notices next to handoff", () => {
    show({submitNotice: "Run could not be queued: Repository access denied"});
    expect(screen.getByText("Run could not be queued: Repository access denied").getAttribute("role")).toBe("status");
  });
  it("renders the selected agent's saved avatar appearance", () => {
    const {container, rerender} = show({
      selectedAgentId: "bot-1",
      agents: [{id: "bot-1", name: "Designer", slug: "designer", role: "design", mascotPreset: "sleeping", look: {shape: "bean", color: "#6e8b6a", eyes: "wink", acc: "headset"}}],
    });
    const mascot = () => container.querySelector(".agent-avatar .shiba-agent-mascot");
    expect(mascot()?.getAttribute("data-shape")).toBe("bean");
    expect(mascot()?.getAttribute("data-color")).toBe("#6e8b6a");
    expect(mascot()?.getAttribute("data-eyes")).toBe("wink");
    expect(container.querySelector(".agent-avatar")?.getAttribute("data-employee-role")).toBe("design");
    rerender(<TasksHomeView task="Fix the bug" onTaskChange={vi.fn()} agents={[{id: "bot-1", name: "Designer", slug: "designer", role: "design", mascotPreset: "sleeping"}]} selectedAgentId="bot-1" onAgentChange={vi.fn()} repoUrl="owner/repo" onRepoUrlChange={vi.fn()} runs={[]} approvals={[]} route={{runTarget: "local"}} onSubmit={vi.fn()} />);
    expect(mascot()?.getAttribute("data-eyes")).toBe("sleepy");
    rerender(<TasksHomeView task="Fix the bug" onTaskChange={vi.fn()} agents={[{id: "bot-1", name: "Designer", slug: "designer", role: "design"}]} selectedAgentId="bot-1" onAgentChange={vi.fn()} repoUrl="owner/repo" onRepoUrlChange={vi.fn()} runs={[]} approvals={[]} route={{runTarget: "local"}} onSubmit={vi.fn()} />);
    expect(mascot()?.getAttribute("data-shape")).toBe("pointed");
  });
  it("offers built-in Shiba even without custom agents and accepts shorthand", async () => {
    const submit = vi.fn(); show({onSubmit: submit});
    expect((screen.getByRole("combobox", {name: "Choose an agent"}) as HTMLSelectElement).disabled).toBe(false);
    expect(screen.getByRole("option", {name: "Shiba"})).toBeTruthy();
    fireEvent.submit(screen.getByRole("form", {name: "Hand off work"}));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit.mock.calls[0]?.[1]).toBe("");
  });
  it("keeps invalid repository errors beside the composer", () => {
    const submit = vi.fn(); show({repoUrl: "https://evil.com/a/b", onSubmit: submit});
    fireEvent.submit(screen.getByRole("form", {name: "Hand off work"}));
    expect(screen.getByRole("alert").textContent).toContain("owner/repo");
    expect(screen.getByRole("combobox", {name: "GitHub repository"}).getAttribute("aria-invalid")).toBe("true");
    expect(submit).not.toHaveBeenCalled();
  });
  it("locks duplicate submits until the handoff finishes", async () => {
    let finish!: () => void;
    const submit = vi.fn(() => new Promise<void>((resolve) => {finish = resolve;})); show({onSubmit: submit});
    const form = screen.getByRole("form", {name: "Hand off work"});
    fireEvent.submit(form); fireEvent.submit(form);
    expect(submit).toHaveBeenCalledTimes(1);
    finish(); await waitFor(() => expect(form.getAttribute("aria-busy")).toBe("false"));
  });
  it("blocks cloud handoff until setup is checked", () => {
    const submit = vi.fn(); show({route: {runTarget: "sandbox"}, onSubmit: submit});
    fireEvent.submit(screen.getByRole("form", {name: "Hand off work"}));
    expect(submit).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain("Checking model setup");
  });

  it("renders suggestions; Do it prefills the composer and Dismiss posts and hides", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return Promise.resolve(Response.json(url === "/api/needs-you"
        ? { suggestions: [{ id: "retry:r1", kind: "retry", title: 'Retry "Fix build"?', detail: "d", action: { kind: "compose", payload: { task: "Fix build" } } }] }
        : { ok: true }));
    }));
    const onTaskChange = vi.fn();
    const onSubmit = vi.fn();
    show({ onTaskChange, onSubmit });
    await screen.findByText('Retry "Fix build"?');
    fireEvent.click(screen.getByRole("button", { name: "Do it" }));
    expect(onTaskChange).toHaveBeenCalledWith("Fix build");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(calls[0]?.[1]?.headers).toEqual({});
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByText('Retry "Fix build"?')).toBeNull());
    expect(calls.some(([url, init]) => url === "/api/needs-you/dismiss" && init?.method === "POST")).toBe(true);
    vi.unstubAllGlobals();
  });
  it("routes routine and setup suggestions without submitting work", async () => {
    const routine = { id: "routine:r1", kind: "routine", title: "Make routine?", detail: "d", action: { kind: "compose", payload: { task: "Audit code", automation: "1" } } };
    const setup = { id: "setup:goal", kind: "setup", title: "Finish setup", detail: "d", action: { kind: "open", payload: { view: "home" } } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ suggestions: [routine, setup] })));
    const onAutomationDraft = vi.fn(); const onOpenSuggestion = vi.fn(); const onSubmit = vi.fn(); const onTaskChange = vi.fn();
    show({ onAutomationDraft, onOpenSuggestion, onSubmit, onTaskChange });
    await screen.findByText("Make routine?");
    const buttons = screen.getAllByRole("button", { name: "Do it" });
    fireEvent.click(buttons[0]!); fireEvent.click(buttons[1]!);
    expect(onAutomationDraft).toHaveBeenCalledWith("Audit code");
    expect(onOpenSuggestion).toHaveBeenCalledWith(setup);
    expect(onTaskChange).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keeps suggestions visible when persistence fails", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(url === "/api/needs-you"
      ? Response.json({ suggestions: [{ id: "retry:r1", kind: "retry", title: "Retry task?", detail: "d", action: { kind: "compose", payload: { task: "Audit" } } }] })
      : Response.json({ error: "Unavailable" }, { status: 503 }))));
    show();
    await screen.findByText("Retry task?");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(await screen.findByText("Could not dismiss suggestion. Please try again.")).toBeTruthy();
    expect(screen.getByText("Retry task?")).toBeTruthy();
  });

});
