// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebThread } from "./agent-threads";
import { AgentsPanel } from "./components/AgentsPanel";
import type { CustomAgentWire } from "./components/CustomAgentsView";
import { WorkOrganizationView } from "./components/WorkOrganizationView";
import { WorkView, type WorkViewMode } from "./components/WorkView";
import type { TeamWorkItem } from "./team-work-items";
import { useWorkTasks } from "./work-mutations";

const WS = `ws_${"a".repeat(24)}`;
const TASK = `task_${"1".padStart(24, "0")}`;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

/** In-memory stand-in for the work routes, so the real client hook drives the UI end to end. */
function fakeWorkBackend() {
  const store = new Map<string, TeamWorkItem>();
  let clock = 10;
  let seq = 0;
  const reply = (task: TeamWorkItem) => Response.json({ task });
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const base = `/api/workspaces/${WS}/work`;
    if (path === base && method === "GET")
      return Response.json({
        workspaceId: WS,
        tasks: [...store.values()].filter((t) => !t.archived),
        truncated: false,
      });
    if (path === base && method === "POST") {
      const task: TeamWorkItem = {
        id: `task_${String(++seq).padStart(24, "0")}`,
        workspaceId: WS,
        roomId: "",
        roomTitle: "",
        title: body.title,
        assigneeKind: "human",
        status: "todo",
        priority: "medium",
        updatedAt: ++clock,
        activity: [{ id: `a-${seq}`, at: Date.now(), kind: "created", text: "created this task" }],
      };
      store.set(task.id, task);
      return reply(task);
    }
    const match = path.match(new RegExp(`^${base}/([^/]+)(/archive)?$`));
    const current = match ? store.get(decodeURIComponent(match[1] ?? "")) : undefined;
    if (current && match?.[2] && method === "POST") {
      const task = { ...current, archived: true, updatedAt: ++clock };
      store.set(task.id, task);
      return reply(task);
    }
    if (current && method === "PATCH") {
      const task = { ...current, ...body.patch, updatedAt: ++clock };
      store.set(task.id, task);
      return reply(task);
    }
    return Response.json({ error: `Unexpected ${method} ${path}` }, { status: 404 });
  });
  vi.stubGlobal("fetch", fetcher);
  return { store, fetcher };
}

/** Mirrors the app.tsx wiring: the writable work hook feeds the workspace Work view. */
function WorkHarness() {
  const work = useWorkTasks("me", WS, true);
  const [view, setView] = useState<WorkViewMode>("list");
  return (
    <WorkView
      workspaceId={WS}
      workspaceName="Acme"
      currentActorId="human:me"
      sharedTasks={work.tasks}
      sharedTasksLoading={work.loading}
      sharedTasksError={work.error ?? undefined}
      view={view}
      onViewChange={setView}
      onScopeChange={vi.fn()}
      onCreateTask={work.create}
      onUpdateTask={(id, patch) => void work.update(id, patch)}
      onArchiveTask={(id) => void work.archive(id)}
      onCommentTask={(id, text) => void work.comment(id, text)}
      agents={[{ id: "agent-1", name: "Coder", role: "engineering" }]}
    />
  );
}

async function renderWorkWithTask(title: string) {
  const backend = fakeWorkBackend();
  render(<WorkHarness />);
  const input = await screen.findByRole("textbox", { name: "Add a task and press Enter" });
  input.focus();
  fireEvent.change(input, { target: { value: title } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(backend.store.size).toBe(1));
  await screen.findByRole("list", { name: "Todo" });
  return { ...backend, input };
}

const everything = () => within(screen.getByRole("region", { name: "Everything" }));
const leftNav = () => within(screen.getByRole("navigation", { name: "Work pages" }));
const detail = () => within(screen.getByRole("complementary", { name: "Task details" }));

describe("Work flow", () => {
  beforeEach(() => window.history.replaceState(null, "", "/"));

  it("shows a real empty state before any task exists", async () => {
    fakeWorkBackend();
    render(<WorkHarness />);
    expect(await screen.findByText("No tasks yet")).toBeTruthy();
    expect(screen.getByText("Add a task above. It lands in Todo.")).toBeTruthy();
    expect(everything().getByText("No open tasks")).toBeTruthy();
  });

  it("quick-add creates the task in Todo and keeps focus in the bar", async () => {
    const { store, fetcher, input } = await renderWorkWithTask("Write launch notes");
    const create = fetcher.mock.calls.find(
      ([url, init]) => url === `/api/workspaces/${WS}/work` && init?.method === "POST",
    );
    expect(JSON.parse(String(create?.[1]?.body))).toEqual({ title: "Write launch notes" });
    expect(store.get(TASK)?.status).toBe("todo");
    expect((input as HTMLInputElement).value).toBe("");
    expect(document.activeElement).toBe(input);
    expect(
      within(screen.getByRole("list", { name: "Todo" })).getByText("Write launch notes"),
    ).toBeTruthy();
  });

  it("lists the new task in the sidebar's Everything section", async () => {
    await renderWorkWithTask("Write launch notes");
    expect(everything().getByText("Write launch notes")).toBeTruthy();
    expect(everything().queryByText("No open tasks")).toBeNull();
  });

  it("opens the detail panel with every property row and section", async () => {
    await renderWorkWithTask("Write launch notes");
    fireEvent.click(
      within(screen.getByRole("list", { name: "Todo" })).getByRole("button", {
        name: /^Write launch notes/,
      }),
    );
    const panel = detail();
    expect((panel.getByRole("textbox", { name: "Task title" }) as HTMLTextAreaElement).value).toBe(
      "Write launch notes",
    );
    expect((panel.getByLabelText("Status") as HTMLSelectElement).value).toBe("todo");
    for (const row of ["Owner", "Reviewer", "Priority", "Dates", "Inside", "Blocked"])
      expect(panel.getByText(row)).toBeTruthy();
    expect(panel.getByLabelText("Start date")).toBeTruthy();
    expect(panel.getByLabelText("End date")).toBeTruthy();
    expect(panel.getByRole("switch")).toBeTruthy();
    for (const section of ["Objective", "Waiting on", "Context", "Done when"])
      expect(panel.getAllByText(section).length).toBeGreaterThan(0);
    expect(new URLSearchParams(window.location.search).get("task")).toBe(TASK);
  });

  it("changing status in the detail panel moves the card across Board columns", async () => {
    const { store } = await renderWorkWithTask("Write launch notes");
    fireEvent.click(leftNav().getByRole("button", { name: /Board/ }));
    expect(
      within(screen.getByTestId("board-column-todo")).getByText("Write launch notes"),
    ).toBeTruthy();
    fireEvent.click(
      within(screen.getByTestId("board-column-todo")).getByRole("button", {
        name: "Write launch notes",
      }),
    );
    fireEvent.change(detail().getByLabelText("Status"), { target: { value: "in-progress" } });
    await waitFor(() => expect(store.get(TASK)?.status).toBe("in-progress"));
    await waitFor(() =>
      expect(
        within(screen.getByTestId("board-column-in_progress")).getByText("Write launch notes"),
      ).toBeTruthy(),
    );
    expect(
      within(screen.getByTestId("board-column-todo")).queryByText("Write launch notes"),
    ).toBeNull();
  });

  it("moving a card from its Board status picker updates the task", async () => {
    const { store } = await renderWorkWithTask("Write launch notes");
    fireEvent.click(leftNav().getByRole("button", { name: /Board/ }));
    fireEvent.change(screen.getByRole("combobox", { name: "Status of Write launch notes" }), {
      target: { value: "in_review" },
    });
    await waitFor(() => expect(store.get(TASK)?.status).toBe("in-review"));
    expect(
      within(screen.getByTestId("board-column-in_review")).getByText("Write launch notes"),
    ).toBeTruthy();
  });

  it("archiving removes the task from the list, sidebar and board", async () => {
    const { store } = await renderWorkWithTask("Write launch notes");
    fireEvent.click(
      within(screen.getByRole("list", { name: "Todo" })).getByRole("button", {
        name: /^Write launch notes/,
      }),
    );
    fireEvent.click(detail().getByRole("button", { name: "Archive task" }));
    await waitFor(() => expect(store.get(TASK)?.archived).toBe(true));
    expect(screen.queryByRole("complementary", { name: "Task details" })).toBeNull();
    expect(screen.queryByText("Write launch notes")).toBeNull();
    expect(everything().getByText("No open tasks")).toBeTruthy();
    fireEvent.click(leftNav().getByRole("button", { name: /Board/ }));
    expect(screen.queryByText("Write launch notes")).toBeNull();
    expect(new URLSearchParams(window.location.search).get("task")).toBeNull();
  });
});

const agent = (id: string, name: string, slug = id): CustomAgentWire =>
  ({ id, slug, version: 1, config: { name } }) as CustomAgentWire;
const thread = (id: string, name: string, agentId: string, updatedAt = 1): WebThread => ({
  id,
  name,
  agentName: "orchestrator",
  updatedAt,
  metadata: { customAgentId: agentId },
});

describe("Organization", () => {
  it("is reachable from the Work pages nav", async () => {
    fakeWorkBackend();
    render(<WorkHarness />);
    fireEvent.click(leftNav().getByRole("button", { name: /Organization/ }));
    const chief = await screen.findByTestId("organization-chief-card");
    expect(within(chief).getByText("Workspace chief of staff")).toBeTruthy();
    expect(screen.getByRole("list", { name: "Member chiefs of staff" })).toBeTruthy();
  });

  it("renders the workspace and personal chiefs of staff with Shiba mascots", () => {
    render(<WorkOrganizationView employees={[]} user={{ id: "u1", name: "Prince" }} />);
    const chief = screen.getByTestId("organization-chief-card");
    expect(within(chief).getByRole("heading", { name: "Shiba" })).toBeTruthy();
    expect(within(chief).getByText("Workspace chief of staff")).toBeTruthy();
    expect(within(chief).getByRole("img", { name: "Shiba" }).getAttribute("src")).toMatch(
      /^\/assets\/mascot\/shiba-sticker-\w+\.webp$/,
    );
    const members = screen.getByRole("list", { name: "Member chiefs of staff" });
    expect(within(members).getByText("Personal chief of staff")).toBeTruthy();
    expect(within(members).getAllByRole("img")[0]?.getAttribute("src")).toMatch(
      /^\/assets\/mascot\/shiba-sticker-\w+\.webp$/,
    );
    expect(screen.getByText("Personal agents are private")).toBeTruthy();
    expect(screen.getByText(/Lines show coordination, not access permissions/)).toBeTruthy();
  });
});

describe("Agents page", () => {
  const panel = (agents: CustomAgentWire[], threads: WebThread[] = [], extra = {}) =>
    render(
      <AgentsPanel
        scope="workspace"
        onScopeChange={vi.fn()}
        active=""
        onSelect={vi.fn()}
        agents={agents}
        threads={threads}
        {...extra}
      />,
    );

  beforeEach(() => localStorage.clear());

  it("lists the Shiba chief of staff and every custom agent with a mascot avatar", () => {
    panel([
      agent("a1", "Coder", "coding-coworker"),
      agent("a2", "Reviewer", "pr-reviewer"),
      agent("a3", "Triage", "support-triage"),
    ]);
    const list = screen.getByRole("list", { name: "Agents" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(4);
    for (const name of ["Shiba", "Coder", "Reviewer", "Triage"])
      expect(within(list).getByText(name)).toBeTruthy();
    const srcs = [...list.querySelectorAll("img")].map((img) => img.getAttribute("src"));
    expect(srcs).toHaveLength(4);
    for (const src of srcs) expect(src).toMatch(/^\/assets\/mascot\/shiba-sticker-\w+\.webp$/);
  });

  it("expands and collapses an agent's threads", () => {
    const onSelectThread = vi.fn();
    panel(
      [agent("a1", "Coder")],
      [thread("t1", "Fix login", "a1", 2), thread("t2", "Other agent", "a2")],
      { onSelectThread },
    );
    fireEvent.click(screen.getByRole("button", { name: "Expand Coder" }));
    const threads = screen.getByRole("group", { name: "Coder threads" });
    expect(within(threads).getByText("Fix login")).toBeTruthy();
    expect(within(threads).queryByText("Other agent")).toBeNull();
    fireEvent.click(within(threads).getByRole("button", { name: /Fix login/ }));
    expect(onSelectThread).toHaveBeenCalledWith("t1");
    const toggle = screen.getByRole("button", { name: "Collapse Coder" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(screen.queryByRole("group", { name: "Coder threads" })).toBeNull();
  });

  it("starts a new thread with a specific agent", () => {
    const onNewThread = vi.fn();
    panel([agent("a1", "Coder")], [], { onNewThread });
    fireEvent.click(screen.getByRole("button", { name: "New thread with Coder" }));
    expect(onNewThread).toHaveBeenCalledWith("a1");
  });

  it("shows an inviting empty state that leads to hiring an agent", () => {
    const onNewAgent = vi.fn();
    panel([], [], { onNewAgent });
    expect(screen.getByRole("heading", { name: "Make room for good work." })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Hire your first teammate/ }));
    expect(onNewAgent).toHaveBeenCalledOnce();
  });
});
