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
  it.each(["view", "chat", "manage", "error"])("gates profile settings with the access endpoint's %s level", async (level) => {
    const agent: CustomAgentWire = { id: "finance", slug: "finance", version: 1, config: { name: "Finance", instructions: "Finance tasks", harness: "opencode" } };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/access")) return level === "error" ? Response.json({ error: "Unavailable" }, { status: 503 }) : Response.json({ level, grants: [] });
      if (url.endsWith("/groups")) return Response.json({ groups: [] });
      if (url.endsWith("/primary-bot")) return Response.json({ actorId: null });
      if (url.startsWith("/api/workspaces/")) return Response.json({ workspace: { members: [] } });
      return Response.json({ agents: [agent] });
    }));
    render(<CustomAgentsView workspaceId={`ws_${"a".repeat(24)}`} onStartThread={vi.fn()} />);
    const edit = await screen.findByRole("button", { name: "Edit bot" }) as HTMLButtonElement;
    await waitFor(() => expect(edit.disabled).toBe(level !== "manage"));
    expect((screen.getByRole("button", { name: "Archive bot Finance" }) as HTMLButtonElement).disabled).toBe(level !== "manage");
    expect((screen.getByRole("button", { name: "Delete bot" }) as HTMLButtonElement).disabled).toBe(level !== "manage");
    fireEvent.click(screen.getByRole("button", { name: "View profile Finance" }));
    expect((screen.getByRole("button", { name: "Edit profile" }) as HTMLButtonElement).disabled).toBe(level !== "manage");
    fireEvent.click(edit);
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(level === "manage" ? "Finance" : "");
  });
  it("searches persisted employee defaults and opens a profile without mutating it", async () => {
    const agents: CustomAgentWire[] = [
      { id: "reviewer-1", slug: "reviewer", version: 3, config: { name: "Release reviewer", instructions: "Inspect changes before publication.", harness: "codex", codingModel: "gpt-review", defaultRepoUrl: "https://github.com/example/release" } },
      { id: "writer-1", slug: "writer", version: 1, config: { name: "Docs writer", instructions: "Write project docs.", harness: "opencode" } },
    ];
    const request = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({ agents }));
    vi.stubGlobal("fetch", request);
    render(<CustomAgentsView />);
    const roster = await screen.findByRole("list", { name: "Saved employees" });
    expect(within(roster).getAllByRole("listitem")).toHaveLength(2);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search employees" }), { target: { value: "GPT-REVIEW" } });
    expect(within(roster).getAllByRole("listitem")).toHaveLength(1);
    fireEvent.click(within(roster).getByRole("button", { name: "View profile Release reviewer" }));
    const profile = screen.getByRole("region", { name: "Release reviewer overview" });
    expect(document.activeElement).toBe(profile);
    expect(within(profile).getByText("Inspect changes before publication.")).toBeTruthy();
    expect(within(profile).getByText("https://github.com/example/release")).toBeTruthy();
    expect(within(profile).getByText("Saved profile · v3")).toBeTruthy();
    expect(request.mock.calls.every((call) => !call[1]?.method)).toBe(true);
    fireEvent.click(within(profile).getByRole("button", { name: "Close profile" }));
    expect(screen.queryByRole("region", { name: "Release reviewer overview" })).toBeNull();
    expect(document.activeElement).toBe(within(roster).getByRole("button", { name: "View profile Release reviewer" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search employees" }), { target: { value: "unknown" } });
    expect(screen.getByText("No employees match your search.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear employee search" }));
    expect(within(roster).getAllByRole("listitem")).toHaveLength(2);
  });

  it("brings the name field into focus for New bot and look starters", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ agents: [] })));
    render(<CustomAgentsView />);
    await screen.findByText("No bots");
    fireEvent.click(screen.getByRole("button", { name: "New bot" }));
    expect(document.activeElement).toBe(screen.getByLabelText("Name"));
    fireEvent.click(screen.getByRole("button", { name: "Sleepy" }));
    expect(document.activeElement).toBe(screen.getByLabelText("Name"));
  });

  it("saves mascot and supplied Gemini model, hydrates edits, preserves failed drafts, and clears automatic presets", async () => {
    let saved: CustomAgentWire | undefined;
    let failSave = false;
    const request = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init?.method) return Response.json({ agents: saved ? [saved] : [] });
      if (failSave) return Response.json({ error: "Try again" }, { status: 503 });
      const payload = JSON.parse(String(init.body));
      saved = { id: "dog-1", slug: payload.slug ?? "my-dog", version: (saved?.version ?? 0) + 1, config: payload.config };
      return Response.json({ agent: saved });
    });
    vi.stubGlobal("fetch", request);
    render(<CustomAgentsView modelSuggestions={["google/gemini-2.5-pro"]} />);
    await screen.findByText("No bots");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "My dog" } });
    fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "Review project notes." } });
    fireEvent.change(screen.getByLabelText("Coding model"), { target: { value: "google/gemini-2.5-pro" } });
    fireEvent.change(screen.getByLabelText("Conversation model"), { target: { value: "@cf/test/chat-model" } });
    fireEvent.change(screen.getByLabelText("Default repository"), { target: { value: "https://github.com/example/project" } });
    fireEvent.click(screen.getByRole("button", { name: "Sleepy" }));
    fireEvent.click(screen.getByRole("button", { name: "Create bot" }));
    await waitFor(() => expect(saved?.config).toMatchObject({ look: { eyes: "sleepy" }, codingModel: "google/gemini-2.5-pro", model: "@cf/test/chat-model", defaultRepoUrl: "https://github.com/example/project" }));
    expect(saved?.config).not.toHaveProperty("mascotPreset");
    fireEvent.click(await screen.findByRole("button", { name: "Edit bot" }));
    expect(screen.getByRole("button", { name: "Sleepy" }).getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByLabelText("Coding model") as HTMLInputElement).value).toBe("google/gemini-2.5-pro");
    expect((screen.getByLabelText("Conversation model") as HTMLInputElement).value).toBe("@cf/test/chat-model");
    fireEvent.click(screen.getByRole("button", { name: "Wrench" }));
    failSave = true;
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Try again");
    expect(screen.getByRole("button", { name: "Wrench" }).getAttribute("aria-pressed")).toBe("true");
    failSave = false;
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(saved?.config.look).toMatchObject({ eyes: "sleepy", acc: "wrench" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Edit bot" }));
    fireEvent.click(screen.getByRole("button", { name: "Automatic" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(saved?.config).not.toHaveProperty("look"));
    expect(saved?.config.codingModel).toBe("google/gemini-2.5-pro");
    const patch = request.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(JSON.parse(String(patch?.[1]?.body)).expectedVersion).toBe(1);
  });
  const self = { kind: "user", userId: "owner@example.test" } as const;
  const otherUser = { kind: "user", userId: "manager@example.test" } as const;
  const employee = { kind: "agent", agentId: "lead" } as const;
  const unavailable = { kind: "agent", agentId: "missing" } as const;
  const otherUserLabel = "Keep saved manager (manager@example.test)";
  const unavailableLabel = "Keep saved manager (unavailable employee)";
  const employeeLabel = "Support lead (support)";

  it.each([
    ["chooses an employee from no manager", undefined, "No manager", employeeLabel, employee],
    ["recognizes the current person", self, "Directly to you", undefined, self],
    ["keeps another human manager", otherUser, otherUserLabel, undefined, otherUser],
    ["replaces another human manager with the current person", otherUser, otherUserLabel, "Directly to you", self],
    ["clears another human manager", otherUser, otherUserLabel, "No manager", undefined],
    ["replaces a listed employee manager with the current person", employee, employeeLabel, "Directly to you", self],
    ["keeps an unavailable employee manager", unavailable, unavailableLabel, undefined, unavailable],
    ["clears an unavailable employee manager", unavailable, unavailableLabel, "No manager", undefined],
  ] as const)("%s", async (_name, before, initialLabel, choice, after) => {
    let saved: CustomAgentWire = {
      id: "assistant", slug: "assistant", version: 1,
      config: { name: "Support assistant", instructions: "Answer customer questions.", harness: "opencode", reportsTo: before },
    };
    const lead: CustomAgentWire = {
      id: "lead", slug: "lead", version: 1,
      config: { name: "Support lead", instructions: "Oversee support.", harness: "opencode", roleTemplateId: "support" },
    };
    const request = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/custom-agents/assistant" && init?.method === "PATCH") {
        const { config } = JSON.parse(String(init.body)) as { config: CustomAgentWire["config"] };
        saved = { ...saved, version: 2, config };
        return Response.json({ agent: saved });
      }
      return Response.json({ agents: [saved, lead] });
    });
    vi.stubGlobal("fetch", request);
    render(<CustomAgentsView actorId={self.userId} />);
    const card = (await screen.findByRole("button", { name: "View profile Support assistant" })).closest("li")!;
    fireEvent.click(within(card).getByRole("button", { name: "Edit bot" }));
    const picker = screen.getByRole("combobox", { name: "Reports to" });
    expect(within(picker).getByRole("option", { selected: true }).textContent).toBe(initialLabel);
    expect(within(picker).queryByRole("option", { name: "Support assistant (general)" })).toBeNull();
    if (choice) {
      const option = within(picker).getByRole("option", { name: choice }) as HTMLOptionElement;
      fireEvent.change(picker, { target: { value: option.value } });
    }
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Bot updated.");
    if (after) expect(saved.config.reportsTo).toEqual(after);
    else expect(saved.config).not.toHaveProperty("reportsTo");
  });

  it("does not offer assignment to yourself without a current person", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ agents: [] })));
    render(<CustomAgentsView />);
    await screen.findByText("No bots");
    const picker = screen.getByRole("combobox", { name: "Reports to" });
    expect(within(picker).getByRole("option", { name: "No manager", selected: true })).toBeTruthy();
    expect(within(picker).queryByRole("option", { name: "Directly to you" })).toBeNull();
  });

  it("does not offer assignment to yourself for the unauthenticated fallback identity", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ agents: [] })));
    render(<CustomAgentsView actorId="default" />);
    await screen.findByText("No bots");
    const picker = screen.getByRole("combobox", { name: "Reports to" });
    expect(within(picker).queryByRole("option", { name: "Directly to you" })).toBeNull();
  });

  it("creates an employee with the manager from a previously saved draft", async () => {
    const scope = "manager-draft";
    const key = `shiba-role-draft-v1:${scope}`;
    localStorage.setItem(key, JSON.stringify({
      name: "Draft assistant", instructions: "Answer questions.", reportsToAgentId: employee.agentId,
    }));
    try {
      const request = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/custom-agents" && init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          return Response.json({ agent: { ...body, id: "draft-assistant", version: 1 } });
        }
        return Response.json({ agents: [{
          id: employee.agentId, slug: "lead", version: 1,
          config: { name: "Support lead", instructions: "Oversee support.", harness: "opencode", roleTemplateId: "support" },
        }] });
      });
      vi.stubGlobal("fetch", request);
      render(<CustomAgentsView actorId={self.userId} draftScope={scope} />);
      const picker = screen.getByRole("combobox", { name: "Reports to" });
      await within(picker).findByRole("option", { name: employeeLabel, selected: true });
      fireEvent.click(screen.getByRole("button", { name: "Create bot" }));
      await screen.findByText("Bot created.");
      const post = request.mock.calls.find(([, init]) => init?.method === "POST");
      expect(JSON.parse(String(post?.[1]?.body)).config.reportsTo).toEqual(employee);
    } finally {
      localStorage.removeItem(key);
    }
  });

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
    await waitFor(() => expect(onStartThread).toHaveBeenCalledOnce());
    const createCall = fetchMock.mock.calls.find((call) => call[0] === "/api/custom-agents" && call[1]?.method === "POST");
    expect(createCall).toBeTruthy();
    const body = JSON.parse(String(createCall?.[1]?.body)) as { slug: string; config: { expectedDeliverables: string[]; instructions: string } };
    expect(body.slug).toBe("research-bot");
    expect(body.config.expectedDeliverables).toEqual(["research/report.md", "research/sources.json"]);
    expect(body.config.instructions).toContain("Answer the user's research question");

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
    const createBtn = screen.getByRole("button", { name: "Create bot" });
    expect(createBtn.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Reviewer" } });
    expect(createBtn.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: /instructions|description/i }), { target: { value: "Do review" } });
    expect(createBtn.hasAttribute("disabled")).toBe(false);
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

const scopeWorkspace = `ws_${"a".repeat(24)}`;
const scopedAgent = (name: string): CustomAgentWire => ({
  id: name.toLowerCase().replaceAll(" ", "-"), slug: name.toLowerCase().replaceAll(" ", "-"), version: 1,
  config: { name, instructions: `${name} private instructions`, harness: "opencode" },
});
function pendingAgentResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((finish) => { resolve = finish; });
  return { promise, resolve };
}

describe("account-scoped employee directory", () => {
  it("hides the previous actor's records immediately in the same workspace and ignores their late response", async () => {
    const lateA = pendingAgentResponse();
    const currentB = pendingAgentResponse();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ agents: [scopedAgent("Account A employee")] }))
      .mockImplementationOnce(() => lateA.promise)
      .mockImplementationOnce(() => currentB.promise);
    vi.stubGlobal("fetch", fetcher);
    const hook = renderHook(({ actorId }) => useCustomAgentOptions(true, scopeWorkspace, actorId), { initialProps: { actorId: "a@example.test" } });
    await waitFor(() => expect(hook.result.current.agents[0]?.config.name).toBe("Account A employee"));
    act(() => hook.result.current.refresh());
    hook.rerender({ actorId: "b@example.test" });
    expect(hook.result.current.agents).toEqual([]);
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.loading).toBe(true);
    await act(async () => { lateA.resolve(Response.json({ agents: [scopedAgent("Late account A employee")] })); });
    expect(hook.result.current.agents).toEqual([]);
    await act(async () => { currentB.resolve(Response.json({ agents: [scopedAgent("Account B employee")] })); });
    expect(hook.result.current.agents[0]?.config.name).toBe("Account B employee");
    const oldRequest = fetcher.mock.calls[1]?.[1] as RequestInit | undefined;
    expect(oldRequest?.signal?.aborted).toBe(true);
    expect(new Headers(fetcher.mock.calls[2]?.[1]?.headers).get("X-Shiba-Workspace")).toBe(scopeWorkspace);
  });

  it("does not repaint an old A cache during A to B to A navigation", async () => {
    const pendingB = pendingAgentResponse();
    const nextA = pendingAgentResponse();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ agents: [scopedAgent("Old A employee")] }))
      .mockImplementationOnce(() => pendingB.promise)
      .mockImplementationOnce(() => nextA.promise);
    vi.stubGlobal("fetch", fetcher);
    const hook = renderHook(({ actorId }) => useCustomAgentOptions(true, undefined, actorId), { initialProps: { actorId: "a@example.test" } });
    await waitFor(() => expect(hook.result.current.agents).toHaveLength(1));
    hook.rerender({ actorId: "b@example.test" });
    hook.rerender({ actorId: "a@example.test" });
    expect(hook.result.current.agents).toEqual([]);
    expect(hook.result.current.loading).toBe(true);
    await act(async () => { pendingB.resolve(Response.json({ agents: [scopedAgent("B employee")] })); });
    expect(hook.result.current.agents).toEqual([]);
    await act(async () => { nextA.resolve(Response.json({ agents: [scopedAgent("Fresh A employee")] })); });
    expect(hook.result.current.agents[0]?.config.name).toBe("Fresh A employee");
  });

  it("hides previous actor errors and clears records synchronously when disabled", async () => {
    const pendingB = pendingAgentResponse();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "No access" }, { status: 403 }))
      .mockImplementationOnce(() => pendingB.promise);
    vi.stubGlobal("fetch", fetcher);
    const hook = renderHook(({ actorId, enabled }) => useCustomAgentOptions(enabled, scopeWorkspace, actorId), { initialProps: { actorId: "a@example.test", enabled: true } });
    await waitFor(() => expect(hook.result.current.error).toBe("unavailable"));
    hook.rerender({ actorId: "b@example.test", enabled: true });
    expect(hook.result.current.error).toBeNull();
    await act(async () => { pendingB.resolve(Response.json({ agents: [scopedAgent("B employee")] })); });
    expect(hook.result.current.agents).toHaveLength(1);
    hook.rerender({ actorId: "b@example.test", enabled: false });
    expect(hook.result.current.agents).toEqual([]);
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.loading).toBe(false);
  });

  it("removes cached profiles when a current refresh loses authorization", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ agents: [scopedAgent("Team employee")] }))
      .mockResolvedValueOnce(Response.json({ error: "Workspace removed" }, { status: 404 }));
    vi.stubGlobal("fetch", fetcher);
    const hook = renderHook(() => useCustomAgentOptions(true, scopeWorkspace, "a@example.test"));
    await waitFor(() => expect(hook.result.current.agents).toHaveLength(1));
    act(() => hook.result.current.refresh());
    await waitFor(() => expect(hook.result.current.error).toBe("unavailable"));
    expect(hook.result.current.agents).toEqual([]);
  });

  it("drops a deferred view directory response after changing actors without requiring an outer key", async () => {
    const old = pendingAgentResponse();
    let directoryRequests = 0;
    const fetcher = vi.fn(async (path: RequestInfo | URL) => {
      if (String(path).endsWith("/primary-bot")) return Response.json({ actorId: null, source: "default" });
      if (path === "/api/custom-agents") {
        directoryRequests++;
        return directoryRequests === 1 ? old.promise : Response.json({ agents: [scopedAgent("Current employee")] });
      }
      throw new Error(`Unexpected request: ${String(path)}`);
    });
    vi.stubGlobal("fetch", fetcher);
    const view = render(<CustomAgentsView actorId="a@example.test" workspaceId={scopeWorkspace} />);
    view.rerender(<CustomAgentsView actorId="b@example.test" workspaceId={scopeWorkspace} />);
    await screen.findByText("Current employee");
    await act(async () => { old.resolve(Response.json({ agents: [scopedAgent("Private old employee")] })); });
    expect(screen.queryByText("Private old employee")).toBeNull();
    expect(screen.getByText("Current employee")).toBeTruthy();
  });

  it.each(["create", "save", "archive", "delete"])("ignores a delayed %s result after the actor changes and does not refetch the previous scope", async (operation) => {
    const old = scopedAgent("Old employee");
    const fresh = scopedAgent("Current account employee");
    const pending = pendingAgentResponse();
    let currentActor = "a";
    const fetcher = vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      if (String(path).endsWith("/primary-bot")) return Response.json({ actorId: null, source: "default" });
      if (String(path).endsWith("/access")) return Response.json({ level: "manage", grants: [] });
      if (String(path).startsWith("/api/custom-agents")) {
        if (init?.method) return pending.promise;
        return Response.json({ agents: [currentActor === "a" ? old : fresh] });
      }
      throw new Error(`Unexpected request: ${String(path)}`);
    });
    vi.stubGlobal("fetch", fetcher);
    const view = render(<CustomAgentsView actorId="a@example.test" workspaceId={scopeWorkspace} />);
    await screen.findByText("Old employee");
    await waitFor(() => expect((screen.getByRole("button", { name: "Edit bot" }) as HTMLButtonElement).disabled).toBe(false));
    if (operation === "create") {
      fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Old saved employee" } });
      fireEvent.change(screen.getByRole("textbox", { name: /instructions|description/i }), { target: { value: "Old private draft" } });
      fireEvent.click(screen.getByRole("button", { name: "Create bot" }));
    } else if (operation === "save") {
      fireEvent.click(screen.getByRole("button", { name: "Edit bot" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Old saved employee" } });
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    } else if (operation === "archive") {
      fireEvent.click(screen.getByRole("button", { name: "Archive bot Old employee" }));
    } else {
      fireEvent.click(screen.getByRole("button", { name: "Delete bot" }));
      fireEvent.click(screen.getByRole("button", { name: "Confirm delete bot" }));
    }
    currentActor = "b";
    view.rerender(<CustomAgentsView actorId="b@example.test" workspaceId={scopeWorkspace} />);
    expect(screen.queryByText("Old employee")).toBeNull();
    expect(screen.queryByDisplayValue("Old private draft")).toBeNull();
    await screen.findByText("Current account employee");
    // Wait until the fresh scope's own requests stop arriving: counting while a
    // refresh is still in flight makes the final "no extra request" assertion
    // flaky in both directions.
    let observed = 0;
    await waitFor(() => {
      const calls = fetcher.mock.calls.length;
      const grew = calls !== observed;
      observed = calls;
      expect(grew).toBe(false);
    });
    const count = fetcher.mock.calls.length;
    await act(async () => { pending.resolve(Response.json({ agent: scopedAgent("Old saved employee"), ok: true })); });
    expect(screen.queryByText("Old saved employee")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/Bot (created|updated|archived|deleted)\./)).toBeNull();
    expect(screen.getByText("Current account employee")).toBeTruthy();
    expect(fetcher).toHaveBeenCalledTimes(count);
    const mutation = fetcher.mock.calls.find(([, init]) => init?.method);
    expect(new Headers(mutation?.[1]?.headers).get("X-Shiba-Workspace")).toBe(scopeWorkspace);
  });

  it("keeps the avatar editor open across a version conflict so the same draft can be saved again", async () => {
    let version = 1;
    let avatar: CustomAgentWire["config"]["avatar"];
    let patches = 0;
    const agent = (): CustomAgentWire => ({ id: "finance", slug: "finance", version, config: { name: "Finance", instructions: "Finance tasks", harness: "opencode", ...(avatar ? { avatar } : {}) } });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/access")) return Response.json({ level: "manage", grants: [] });
      if (url.endsWith("/groups")) return Response.json({ groups: [] });
      if (url.endsWith("/primary-bot")) return Response.json({ actorId: null });
      if (url.startsWith("/api/workspaces/") && !url.includes("custom-agents")) return Response.json({ workspace: { members: [] } });
      if (url === "/api/custom-agents" || url.startsWith("/api/custom-agents?")) return Response.json({ agents: [agent()] });
      if (url.endsWith("/finance") && (init?.method ?? "GET") === "PATCH") {
        patches += 1;
        if (patches === 1) return Response.json({ error: "version_conflict" }, { status: 409 });
        const sent = JSON.parse(String(init?.body)) as { config: CustomAgentWire["config"] };
        avatar = sent.config.avatar;
        version += 1;
        return Response.json({ agent: agent() });
      }
      if (url.endsWith("/finance")) { version += 1; return Response.json({ agent: agent() }); }
      throw new Error(`Unexpected request: ${url}`);
    }));

    render(<CustomAgentsView workspaceId={`ws_${"b".repeat(24)}`} onStartThread={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "View profile Finance" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit avatar" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Coat 3" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save avatar" }));

    const alert = await within(await screen.findByRole("dialog")).findByRole("alert");
    expect(alert.textContent).toContain("This bot changed since you opened it");
    expect(alert.textContent).toContain("save again");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save avatar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(patches).toBe(2);
    expect(avatar).toMatchObject({ kind: "variant" });
  });
});

const designWorkspace = `ws_${"c".repeat(24)}`;

/** A workspace directory: every endpoint the profile panels read answers, and writes are reported to the caller. */
function stubWorkspaceDirectory(agents: CustomAgentWire[]) {
  const writes: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method && init.method !== "GET") { writes.push({ url, init }); return Response.json({ error: "unexpected write" }, { status: 500 }); }
    if (url.endsWith("/access")) return Response.json({ level: "manage", grants: [] });
    if (url.endsWith("/groups")) return Response.json({ groups: [] });
    if (url.endsWith("/primary-bot")) return Response.json({ actorId: null });
    if (url.startsWith("/api/workspaces/")) return Response.json({ workspace: { members: [] } });
    return Response.json({ agents });
  }));
  return writes;
}

/** The small avatar beside the New bot / Edit bot heading. */
function formPreview(): Element | null {
  const heading = screen.getByRole("heading", { name: /^(New|Edit) bot$/ });
  return heading.parentElement?.parentElement?.querySelector("svg.shiba-agent-mascot") ?? null;
}

describe("employee directory and hire design", () => {
  const roster: CustomAgentWire[] = [
    { id: "eng-1", slug: "builder", version: 1, config: { name: "Builder", instructions: "Build.", harness: "opencode", roleTemplateId: "engineering" } },
    { id: "fin-1", slug: "auditor", version: 1, config: { name: "Auditor", instructions: "Audit.", harness: "opencode", roleTemplateId: "finance" } },
    { id: "fin-2", slug: "bookkeeper", version: 1, config: { name: "Bookkeeper", instructions: "Reconcile.", harness: "codex", roleTemplateId: "finance" } },
  ];

  it("filters saved employees by the roles they carry, combines it with search, and reports the visible count", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ agents: roster })));
    render(<CustomAgentsView />);
    const list = await screen.findByRole("list", { name: "Saved employees" });
    expect(screen.getByText("3 of 3 saved employees")).toBeTruthy();
    const filter = screen.getByLabelText("Filter by role") as HTMLSelectElement;
    // Only roles a saved employee carries are offered, once each, in roster order.
    expect([...filter.options].map((option) => option.textContent)).toEqual(["All roles", "Engineering", "Finance"]);

    fireEvent.change(filter, { target: { value: "finance" } });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).queryByRole("button", { name: "View profile Builder" })).toBeNull();
    expect(screen.getByText("2 of 3 saved employees")).toBeTruthy();

    // Search narrows inside the chosen role; clearing resets both controls.
    fireEvent.change(screen.getByRole("searchbox", { name: "Search employees" }), { target: { value: "codex" } });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(within(list).getByRole("button", { name: "View profile Bookkeeper" })).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search employees" }), { target: { value: "builder" } });
    expect(screen.getByText("No employees match your search.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear employee search" }));
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(filter.value).toBe("all");
  });

  it("searches by role label and hides the role filter when every employee shares one role", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ agents: roster.slice(1) })));
    render(<CustomAgentsView />);
    const list = await screen.findByRole("list", { name: "Saved employees" });
    expect(screen.queryByLabelText("Filter by role")).toBeNull();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search employees" }), { target: { value: "finance" } });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
  });

  it("states the interactive and automation approval boundaries on a personal profile without granting anything", async () => {
    const agents: CustomAgentWire[] = [{ id: "fin-1", slug: "auditor", version: 2, config: {
      name: "Auditor", instructions: "Audit invoices.", harness: "opencode", roleTemplateId: "finance", expectedDeliverables: ["reports/exceptions.md"] } }];
    const request = vi.fn(async () => Response.json({ agents }));
    vi.stubGlobal("fetch", request);
    render(<CustomAgentsView />);
    fireEvent.click(await screen.findByRole("button", { name: "View profile Auditor" }));
    const profile = screen.getByRole("region", { name: "Auditor overview" });
    expect(within(profile).getByText("reports/exceptions.md")).toBeTruthy();
    expect(within(profile).getByRole("heading", { name: "How this employee works" })).toBeTruthy();
    expect(within(profile).getByText("Task brief and context explicitly supplied for the approved request.")).toBeTruthy();
    expect(within(profile).getByText(/reports\/exceptions\.md/)).toBeTruthy();
    // The approval sentence appears in both the workflow list and the Boundaries card.
    expect(within(profile).getAllByText(/need your approval of the exact task before anything runs/).length).toBeGreaterThanOrEqual(2);
    expect(within(profile).getAllByText(/Automated runs also require human approval\./).length).toBeGreaterThanOrEqual(1);
    expect(within(profile).queryByText(/unattended|allowlist/i)).toBeNull();
    const boundaries = within(profile).getByRole("complementary", { name: "Boundaries" });
    expect(within(boundaries).getByText(/grants no tool or app access/)).toBeTruthy();
    const link = within(boundaries).getByRole("link", { name: /Review employee tool policy/ });
    expect(link.getAttribute("href")).toBe("/employee-tools/");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(request.mock.calls.every((call) => !(call as unknown as [unknown, RequestInit?])[1]?.method)).toBe(true);
  });

  it("offers no tool-policy link inside a team workspace, in the profile or the hire form", async () => {
    stubWorkspaceDirectory([{ id: "fin-1", slug: "auditor", version: 1, config: { name: "Auditor", instructions: "Audit.", harness: "opencode" } }]);
    render(<CustomAgentsView workspaceId={designWorkspace} />);
    fireEvent.click(await screen.findByRole("button", { name: "View profile Auditor" }));
    const boundaries = within(screen.getByRole("region", { name: "Auditor overview" })).getByRole("complementary", { name: "Boundaries" });
    expect(within(boundaries).getByText(/available for personal employee profiles only/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: /employee tool policy/ })).toBeNull();
    // The Boundaries card, the workflow tools note and the hire stage say it; none links to a personal-only page.
    expect(screen.getAllByText(/available for personal employee profiles only/)).toHaveLength(3);
  });

  it("shows the personal tool-access setup CTA after hiring without granting access", async () => {
    let created: CustomAgentWire | undefined;
    const onOpenToolPolicy = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const payload = JSON.parse(String(init.body));
        created = { id: "personal-1", slug: payload.slug, version: 1, config: payload.config };
        return Response.json({ agent: created }, { status: 201 });
      }
      return Response.json({ agents: created ? [created] : [] });
    }));
    render(<CustomAgentsView onOpenToolPolicy={onOpenToolPolicy} />);
    await screen.findByText("No bots");
    expect(screen.getByRole("list", { name: "Hire steps" }).textContent).toContain("Define the role");
    expect(screen.getByRole("list", { name: "Hire steps" }).textContent).toContain("Set boundaries");
    expect(screen.getByRole("list", { name: "Hire steps" }).textContent).toContain("Review the hire");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Finance helper" } });
    fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "Review supplied data." } });
    fireEvent.click(screen.getByRole("button", { name: "Create bot" }));
    const button = await screen.findByRole("button", { name: "Set up tool access" });
    expect(screen.getByText("Tool access is a separate decision; this profile granted nothing.")).toBeTruthy();
    expect(onOpenToolPolicy).not.toHaveBeenCalled();
    fireEvent.click(button);
    // The new employee is preselected in Tool policy; nothing is granted by opening it.
    expect(onOpenToolPolicy).toHaveBeenCalledExactlyOnceWith("personal-1");
    expect(created).toBeTruthy();
  });

  it("links the tool policy from the hire stage in personal scope", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ agents: [] })));
    render(<CustomAgentsView />);
    await screen.findByText("No bots");
    const stage = screen.getByRole("heading", { name: "Set boundaries" }).closest("section") as HTMLElement;
    expect(within(stage).getByText(/need your approval of the exact task before anything runs/)).toBeTruthy();
    expect(within(stage).getByRole("link", { name: /Review employee tool policy/ }).getAttribute("href")).toBe("/employee-tools/");
  });

  it("opens the editor's tool policy in a new tab instead of leaving an unsaved edit", async () => {
    const agent = { id: "fin-1", slug: "auditor", version: 1, config: { name: "Auditor", instructions: "Audit.", harness: "opencode" } };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ agents: [agent] })));
    const onOpenToolPolicy = vi.fn();
    render(<CustomAgentsView onOpenToolPolicy={onOpenToolPolicy} />);
    fireEvent.click(await screen.findByRole("button", { name: "View profile Auditor" }));
    const profile = screen.getByRole("region", { name: "Auditor overview" });
    fireEvent.click(within(profile).getByRole("button", { name: "Edit profile" }));
    const name = screen.getByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "Unsaved Auditor" } });

    const stage = screen.getByRole("heading", { name: "Set boundaries" }).closest("section") as HTMLElement;
    const link = within(stage).getByRole("link", { name: /Review employee tool policy/ });
    expect(link).toHaveProperty("target", "_blank");
    expect(link.getAttribute("href")).toBe("/employee-tools/");
    fireEvent.click(link);
    expect(onOpenToolPolicy).not.toHaveBeenCalled();
    expect(name).toHaveProperty("value", "Unsaved Auditor");
  });

  it("walks the hire stages, reviews the real settings, and saves only real fields", async () => {
    let body: { slug?: string; config: Record<string, unknown> } | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== "POST") return Response.json({ agents: [] });
      body = JSON.parse(String(init.body));
      return Response.json({ agent: { id: "new-1", slug: body?.slug ?? "", version: 1, config: body?.config } }, { status: 201 });
    }));
    render(<CustomAgentsView workspaceId={designWorkspace} connections={[{ id: "conn-1", label: "Team OpenAI", status: "ready" } as never]} />);
    await screen.findByText("No bots");
    expect(screen.getByRole("heading", { name: "Define the role" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Set boundaries" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Review the hire" })).toBeTruthy();
    expect(screen.getByText("Step 1 of 3")).toBeTruthy();
    expect(screen.getByText("Step 3 of 3")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Hire employee" }));
    expect(document.activeElement).toBe(screen.getByLabelText("Name"));
    const review = screen.getByRole("heading", { name: "Review the hire" }).closest("section") as HTMLElement;
    expect(within(review).getByText("Not named yet · Custom")).toBeTruthy();
    expect(within(review).getByText("None required")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create bot" }).hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Finance Auditor" } });
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "finance" } });
    fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "Review approved invoices." } });
    fireEvent.change(screen.getByLabelText("Coding model"), { target: { value: "gpt-review" } });
    fireEvent.change(screen.getByLabelText("Model connection"), { target: { value: "conn-1" } });
    fireEvent.change(screen.getByLabelText("Default repository"), { target: { value: "https://github.com/example/books" } });
    fireEvent.change(screen.getByLabelText(/^Required deliverables/), { target: { value: "reports/a.md\nreports/b.md" } });
    expect(screen.queryByRole("radiogroup", { name: "Agent access" })).toBeNull();

    expect(within(review).getByText("Finance Auditor · Finance")).toBeTruthy();
    expect(within(review).getByText("workspace default · gpt-review · chat deployment default")).toBeTruthy();
    expect(within(review).getByText("Team OpenAI")).toBeTruthy();
    expect(within(review).getByText("https://github.com/example/books")).toBeTruthy();
    expect(within(review).getByText("2 required paths")).toBeTruthy();
    expect(within(review).getByText("Interactive tasks and automated runs require human approval.")).toBeTruthy();
    expect(within(review).getByText(/opens its first conversation; it does not start a computer or run/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Create bot" }));
    await screen.findByText("Bot created.");
    expect(body?.config).toEqual({
      name: "Finance Auditor", instructions: "Review approved invoices.", roleTemplateId: "finance", department: "finance",
      codingModel: "gpt-review", connectionId: "conn-1", defaultRepoUrl: "https://github.com/example/books", expectedDeliverables: ["reports/a.md", "reports/b.md"],
    });
    expect(body?.config).not.toHaveProperty("access");
    expect(body?.config).not.toHaveProperty("approvalPolicy");
    expect(body?.config).not.toHaveProperty("toolScopes");
    expect(body?.config).not.toHaveProperty("avatar");
  });

  it("previews the look being chosen for a new hire and saves it as look fields only", async () => {
    let body: { config: Record<string, unknown> } | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== "POST") return Response.json({ agents: [] });
      body = JSON.parse(String(init.body));
      return Response.json({ agent: { id: "new-1", slug: "scout", version: 1, config: body?.config } }, { status: 201 });
    }));
    render(<CustomAgentsView />);
    await screen.findByText("No bots");
    const picker = screen.getByRole("group", { name: "Avatar" });
    fireEvent.click(screen.getByRole("button", { name: "Sleepy" }));
    expect(picker.querySelector('svg.shiba-agent-mascot[data-eyes="sleepy"]')).toBeTruthy();
    expect(formPreview()?.getAttribute("data-eyes")).toBe("sleepy");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Scout" } });
    fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "Look around." } });
    fireEvent.click(screen.getByRole("button", { name: "Create bot" }));
    await screen.findByText("Bot created.");
    expect(body?.config).toMatchObject({ look: { eyes: "sleepy" } });
    expect(body?.config).not.toHaveProperty("avatar");
  });

  it("shows a saved avatar choice on the card, the profile and the edit preview, and keeps it through an edit", async () => {
    const avatar = { kind: "variant", variant: "coder", color: "#2c3e6b" } as const;
    const agent: CustomAgentWire = { id: "eng-1", slug: "builder", version: 4, config: {
      name: "Builder", instructions: "Build.", harness: "opencode", roleTemplateId: "engineering", avatar,
      // A stale look must not win over the saved avatar.
      look: { shape: "round", color: "#f4e2c4", eyes: "sleepy", acc: "none" } } };
    let patched: { config: Record<string, unknown>; expectedVersion: number } | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        patched = JSON.parse(String(init.body));
        return Response.json({ agent: { ...agent, version: 5, config: patched?.config } });
      }
      return Response.json({ agents: [agent] });
    }));
    render(<CustomAgentsView />);
    const list = await screen.findByRole("list", { name: "Saved employees" });
    const drawn = (root: Element) => root.querySelector("svg.shiba-agent-mascot");
    // Variant "coder" draws its own eyes and glyph at the chosen coat, not the stale look.
    for (const root of [within(list).getByRole("listitem")]) {
      expect(drawn(root)?.getAttribute("data-eyes")).toBe("code");
      expect(drawn(root)?.getAttribute("data-color")).toBe("#2c3e6b");
      expect(drawn(root)?.getAttribute("data-acc")).toBe("wrench");
    }
    fireEvent.click(within(list).getByRole("button", { name: "View profile Builder" }));
    const profile = screen.getByRole("region", { name: "Builder overview" });
    expect(drawn(profile)?.getAttribute("data-eyes")).toBe("code");

    fireEvent.click(within(profile).getByRole("button", { name: "Edit profile" }));
    expect(formPreview()?.getAttribute("data-eyes")).toBe("code");
    expect(formPreview()?.getAttribute("data-color")).toBe("#2c3e6b");
    expect(screen.getByText(/saved avatar, which takes precedence over the look above/)).toBeTruthy();
    // Picking a look while a saved avatar exists does not repaint the preview...
    fireEvent.click(screen.getByRole("button", { name: "Sleepy" }));
    expect(formPreview()?.getAttribute("data-eyes")).toBe("code");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Builder Prime" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Bot updated.");
    // ...and the save carries the avatar forward untouched.
    expect(patched?.expectedVersion).toBe(4);
    expect(patched?.config.avatar).toEqual(avatar);
    expect(patched?.config.name).toBe("Builder Prime");
  });

  it("does not show the saved-avatar note for a new hire or an employee without a saved avatar", async () => {
    const plain: CustomAgentWire = { id: "w-1", slug: "writer", version: 1, config: { name: "Writer", instructions: "Write.", harness: "opencode" } };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ agents: [plain] })));
    render(<CustomAgentsView />);
    await screen.findByRole("list", { name: "Saved employees" });
    expect(screen.queryByText(/saved avatar, which takes precedence/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit bot" }));
    expect(screen.queryByText(/saved avatar, which takes precedence/)).toBeNull();
  });
});
