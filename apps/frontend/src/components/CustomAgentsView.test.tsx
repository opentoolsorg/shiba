// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook, screen, fireEvent, waitFor, within } from "@testing-library/react";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

import { CustomAgentsView, type CustomAgentWire, useCustomAgentOptions } from "./CustomAgentsView";
import { createAgentThread } from "../agent-threads";

describe("CustomAgentsView", () => {
  it("skips fetching when disabled and loads bots when enabled", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        agents: [
          {
            id: "ag-1",
            slug: "reviewer",
            version: 1,
            config: { name: "Reviewer", instructions: "Review PRs", harness: "opencode" },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result, rerender } = renderHook(({ enabled }) => useCustomAgentOptions(enabled), {
      initialProps: { enabled: false },
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.agents).toEqual([]);
    expect(result.current.loading).toBe(false);

    rerender({ enabled: true });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.current.agents).toHaveLength(1);
    expect(result.current.agents[0]?.id).toBe("ag-1");
  });

  it("does not resurrect a removed bot from a stale directory request", async () => {
    let finishFirst!: (response: Response) => void;
    const request = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finishFirst = resolve; }))
      .mockResolvedValueOnce(Response.json({ agents: [] }));
    vi.stubGlobal("fetch", request);
    const { result } = renderHook(() => useCustomAgentOptions());
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => finishFirst(Response.json({ agents: [{
      id: "removed-bot", slug: "removed", version: 1,
      config: { name: "Removed", instructions: "Old", harness: "opencode" },
    }] })));
    expect(result.current.agents).toEqual([]);
  });

  it("shows only this bot's named threads and opens the selected conversation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ agents: [{
      id: "ag-1", slug: "reviewer", version: 1,
      config: { name: "Reviewer", instructions: "Review carefully.", harness: "codex" },
    }] })));
    const onOpenThread = vi.fn();
    render(<CustomAgentsView threads={[
      { id: "a", name: "Review authentication", agentName: "web:user:a", updatedAt: 1, metadata: { customAgentId: "ag-1" } },
      { id: "b", name: "Build another project", agentName: "web:user:b", updatedAt: 2, metadata: { customAgentId: "ag-2" } },
      { id: "c", name: "Generic conversation", agentName: "web:user:c", updatedAt: 3 },
    ]} onOpenThread={onOpenThread} />);
    const thread = await screen.findByRole("button", { name: /Review authentication/ });
    expect(screen.queryByText("Build another project")).toBeNull();
    expect(screen.queryByText("Generic conversation")).toBeNull();
    fireEvent.click(thread);
    expect(onOpenThread).toHaveBeenCalledWith("a");
  });

  it("distinguishes unavailable thread history from an empty bot", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ agents: [{
      id: "ag-1", slug: "reviewer", version: 1,
      config: { name: "Reviewer", instructions: "Review carefully.", harness: "codex" },
    }] })));
    render(<CustomAgentsView onOpenThread={vi.fn()} threadsUnavailable />);
    await screen.findByText("Reviewer");
    expect(screen.getByText(/Thread history is unavailable/)).toBeTruthy();
    expect(screen.queryByText("No threads yet.")).toBeNull();
  });

  it("starts a thread from an agent card without submitting a run", async () => {
    const agent = {
      id: "ag-1", slug: "reviewer", version: 1,
      config: { name: "Reviewer", instructions: "Review carefully.", harness: "codex" },
    };
    const request = vi.fn().mockResolvedValue(Response.json({ agents: [agent] }));
    vi.stubGlobal("fetch", request);
    let finish!: () => void;
    const onStartThread = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<CustomAgentsView onStartThread={onStartThread} />);
    const start = await screen.findByRole("button", { name: "Launch bot Reviewer" });
    fireEvent.click(start);
    fireEvent.click(start);
    expect(onStartThread).toHaveBeenCalledOnce();
    expect(onStartThread).toHaveBeenCalledWith(agent);
    expect(start.hasAttribute("disabled")).toBe(true);
    expect(request).toHaveBeenCalledOnce();
    finish();
    await waitFor(() => expect(start.hasAttribute("disabled")).toBe(false));
  });

  it("shows thread creation errors and lets the user retry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ agents: [{
      id: "ag-1", slug: "reviewer", version: 1,
      config: { name: "Reviewer", instructions: "Review carefully.", harness: "codex" },
    }] })));
    const onStartThread = vi.fn().mockRejectedValueOnce(new Error("Session limit reached")).mockResolvedValue(undefined);
    render(<CustomAgentsView onStartThread={onStartThread} />);
    fireEvent.click(await screen.findByRole("button", { name: "Launch bot Reviewer" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Session limit reached"));
    fireEvent.click(screen.getByRole("button", { name: "Launch bot Reviewer" }));
    await waitFor(() => expect(onStartThread).toHaveBeenCalledTimes(2));
  });

  it("lists agents from the API and opens the create form", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/custom-agents") {
        return {
          ok: true,
          json: async () => ({
            agents: [
              {
                id: "ag-1",
                slug: "reviewer",
                version: 1,
                config: {
                  name: "Reviewer",
                  instructions: "Review PRs carefully.",
                  harness: "opencode",
                },
              },
            ],
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<CustomAgentsView />);

    await waitFor(() => {
      expect(screen.getByText("Reviewer")).toBeTruthy();
    });
    expect(screen.getByText(/reviewer/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create bot" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Edit bot" }));
    expect(screen.getByDisplayValue("Reviewer")).toBeTruthy();
  });

  it("loads an onboarding role, saves it, launches a conversation, and restores its persisted thread", async () => {
    let savedAgent: { id: string; slug: string; version: number; config: { name: string; instructions: string; harness: string; expectedDeliverables: string[] } } | null = null;
    let savedSession: { id: string; name: string; agentName: string; updatedAt: number; metadata: { customAgentId: string } } | null = null;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/custom-agents" && init?.method === "POST") {
        savedAgent = {
          id: "research-1", slug: "research-bot", version: 1,
          config: { name: "Research bot", instructions: JSON.parse(String(init.body)).config.instructions, harness: "opencode", expectedDeliverables: ["research/report.md", "research/sources.json"] },
        };
        return Response.json({ agent: savedAgent });
      }
      if (url === "/api/sessions" && init?.method === "POST") {
        const requestBody = JSON.parse(String(init.body)) as { metadata: { customAgentId: string } };
        savedSession = { id: "research-session", name: "Research bot", agentName: "web:owner:research-session", updatedAt: 8, metadata: requestBody.metadata };
        return Response.json({ session: savedSession }, { status: 201 });
      }
      return Response.json({ agents: savedAgent ? [savedAgent] : [] });
    });
    const onApplied = vi.fn();
    const onOpenThread = vi.fn();
    const onStartThread = vi.fn(async (profile: CustomAgentWire) => { await createAgentThread(profile); });
    vi.stubGlobal("fetch", fetchMock);

    const props = { initialTemplateId: "research" as const, onInitialTemplateApplied: onApplied, onStartThread, onOpenThread };
    const view = render(<CustomAgentsView {...props} />);

    await waitFor(() => expect(screen.getByDisplayValue("Research bot")).toBeTruthy());
    expect(screen.getByDisplayValue("research-bot")).toBeTruthy();
    expect(screen.getByDisplayValue(/Create research\/report\.md/)).toBeTruthy();
    expect(onApplied).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Create bot" }));
    await waitFor(() => expect(screen.getByText("Bot created.")).toBeTruthy());
    const createCall = fetchMock.mock.calls.find((call) => call[0] === "/api/custom-agents" && call[1]?.method === "POST");
    expect(createCall).toBeTruthy();
    const body = JSON.parse(String(createCall?.[1]?.body)) as { slug: string; config: { expectedDeliverables: string[]; instructions: string } };
    expect(body.slug).toBe("research-bot");
    expect(body.config.expectedDeliverables).toEqual(["research/report.md", "research/sources.json"]);
    expect(body.config.instructions).toContain("Answer the user's research question");

    const launch = await screen.findByRole("button", { name: "Launch bot Research bot" });
    fireEvent.click(launch);
    await waitFor(() => expect(onStartThread).toHaveBeenCalledOnce());
    expect(onStartThread).toHaveBeenCalledWith(savedAgent);
    expect(savedSession).toMatchObject({ metadata: { customAgentId: "research-1" }, id: "research-session" });

    view.rerender(<CustomAgentsView {...props} threads={[savedSession!]} />);
    const thread = within(screen.getByRole("list", { name: "Research bot threads" })).getByRole("button", { name: /Research bot/ });
    fireEvent.click(thread);
    expect(onOpenThread).toHaveBeenCalledWith("research-session");
  });

  it("ignores repeated launch clicks while a conversation request is pending", async () => {
    let release!: () => void;
    const request = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ agents: [{
      id: "agent-1", slug: "research-bot", version: 1,
      config: { name: "Research bot", instructions: "Research", harness: "opencode" },
    }] })));
    const onStartThread = vi.fn(() => request);
    render(<CustomAgentsView onStartThread={onStartThread} />);
    const launch = await screen.findByRole("button", { name: "Launch bot Research bot" });
    fireEvent.click(launch);
    fireEvent.click(launch);
    expect(onStartThread).toHaveBeenCalledOnce();
    release();
    await waitFor(() => expect((screen.getByRole("button", { name: "Launch bot Research bot" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("shows a skeleton, then an error with retry", async () => {
    const fetchMock = vi.fn(
      () => new Promise(() => {}) as Promise<Response>,
    );
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<CustomAgentsView />);
    expect(screen.getByLabelText("Loading bots")).toBeTruthy();

    const failed = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    vi.stubGlobal("fetch", failed);
    rerender(<CustomAgentsView />);
    // The first mount already started a hanging fetch. Render a fresh tree.
    cleanup();
    render(<CustomAgentsView />);
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("503");
    });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(failed).toHaveBeenCalledTimes(2);
  });

  it("requires name and instructions before creating", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ agents: [] }) })),
    );
    render(<CustomAgentsView />);
    await waitFor(() => {
      expect(screen.getByText("No bots")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Create bot" }));
    expect(screen.getByRole("alert").textContent).toContain("Name and instructions are required.");
  });

  it("asks before deleting and removes the row after the server accepts", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return { ok: true, json: async () => ({ ok: true }) };
      return {
        ok: true,
        json: async () => ({
          agents: [
            {
              id: "ag-1",
              slug: "reviewer",
              version: 1,
              config: { name: "Reviewer", instructions: "Review PRs carefully.", harness: "opencode" },
            },
          ],
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CustomAgentsView />);
    await waitFor(() => expect(screen.getByText("Reviewer")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Delete bot" }));
    expect(screen.getByRole("button", { name: "Confirm delete bot" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete bot" }));
    await waitFor(() => {
      expect(screen.getByText("Bot deleted.")).toBeTruthy();
    });
  });
});
