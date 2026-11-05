// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryTab } from "./MemoryTab";
import type { MemoryFact, MemorySession } from "../types";

const json = (value: unknown) => Response.json(value);

const mockFacts: MemoryFact[] = [
  {
    id: "f_1",
    fact: "User prefers pnpm and TypeScript for all frontend apps.",
    source: "run",
    agent: "architect",
    created_at: Date.now() - 60_000,
  },
  {
    id: "f_2",
    fact: "Primary production mailbox is ops@shiba.local.",
    source: "email",
    agent: "assistant",
    created_at: Date.now() - 120_000,
  },
];

const mockSessions: MemorySession[] = [
  {
    id: "sess_1",
    agent: "architect",
    summary: "Reviewed durable memory architecture and schema design.",
    started_at: Date.now() - 300_000,
  },
];

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json({ facts: [], sessions: [], sources: [], projects: [] })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MemoryTab", () => {
  it("renders breadcrumb header and banked facts list", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/memory/facts") return json({ facts: mockFacts });
      if (path === "/api/memory/sessions") return json({ sessions: mockSessions });
      return json({});
    });
    vi.stubGlobal("fetch", fetcher);

    render(<MemoryTab scope="workspace" activeView="facts" />);

    expect(screen.getByText("Workspace")).toBeDefined();
    expect(screen.getByText("Memory")).toBeDefined();
    expect(screen.getAllByText("Banked Facts").length).toBeGreaterThan(0);

    await waitFor(() => {
      expect(screen.getByText(/User prefers pnpm and TypeScript/)).toBeDefined();
      expect(screen.getByText(/Primary production mailbox/)).toBeDefined();
    });
  });

  it("handles view switching between facts, sessions, and sources", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/memory/facts") return json({ facts: mockFacts });
      if (path === "/api/memory/sessions") return json({ sessions: mockSessions });
      if (path.startsWith("/api/memory/sources")) return json({ sources: [] });
      if (path.startsWith("/api/memory/projects")) return json({ projects: [] });
      return json({});
    });
    vi.stubGlobal("fetch", fetcher);

    const onSelectView = vi.fn();
    const { rerender } = render(
      <MemoryTab activeView="facts" onSelectView={onSelectView} />,
    );

    await waitFor(() => {
      expect(screen.getByText(/User prefers pnpm and TypeScript/)).toBeDefined();
    });

    rerender(<MemoryTab activeView="sessions" onSelectView={onSelectView} />);
    await waitFor(() => {
      expect(screen.getByText(/Session sess_1/)).toBeDefined();
    });
    fireEvent.click(screen.getByText(/Session sess_1/));
    expect(screen.getByText(/Reviewed durable memory architecture/)).toBeDefined();

    rerender(<MemoryTab activeView="sources" onSelectView={onSelectView} />);
    await waitFor(() => {
      expect(screen.getByLabelText("Workspace memory sources")).toBeDefined();
    });
  });

  it("performs semantic recall query", async () => {
    const recallResult: MemoryFact = {
      id: "f_recall",
      fact: "Stack convention: Tailwind CSS v4 and React 18.",
      source: "run",
      agent: "architect",
      score: 0.94,
      created_at: Date.now(),
    };

    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/memory/facts?q=tailwind")) {
        return json({ facts: [recallResult] });
      }
      if (path === "/api/memory/facts") return json({ facts: mockFacts });
      if (path === "/api/memory/sessions") return json({ sessions: mockSessions });
      return json({});
    });
    vi.stubGlobal("fetch", fetcher);

    render(<MemoryTab initialFacts={mockFacts} initialSessions={mockSessions} />);

    const input = screen.getByPlaceholderText(/Recall a fact/);
    fireEvent.change(input, { target: { value: "tailwind" } });
    fireEvent.click(screen.getByRole("button", { name: "Recall" }));

    await waitFor(() => {
      expect(screen.getByText(/Stack convention: Tailwind CSS/)).toBeDefined();
      expect(screen.getByText(/Score 0.94/)).toBeDefined();
    });
  });

  it("handles two-step confirm forget fact with DELETE request", async () => {
    let deletedId: string | null = null;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/memory/facts/f_1") && init?.method === "DELETE") {
        deletedId = "f_1";
        return json({ ok: true });
      }
      return json({});
    });
    vi.stubGlobal("fetch", fetcher);

    const onForgetFact = vi.fn();
    render(
      <MemoryTab
        initialFacts={mockFacts}
        initialSessions={mockSessions}
        onForgetFact={onForgetFact}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Forget fact f_1" }));
    expect(screen.getByText(/Permanently forget this fact/)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Confirm forget" }));

    await waitFor(() => {
      expect(deletedId).toBe("f_1");
      expect(onForgetFact).toHaveBeenCalledWith("f_1");
    });
  });

  it("reports the remaining total fact count after forgetting", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ ok: true })));
    const onCountsChange = vi.fn();
    render(<MemoryTab initialFacts={mockFacts} initialSessions={mockSessions} onCountsChange={onCountsChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Forget fact f_1" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm forget" }));
    await waitFor(() => expect(onCountsChange).toHaveBeenCalledWith({ facts: 1 }));
  });

  it("filters facts by source chip", async () => {
    render(<MemoryTab initialFacts={mockFacts} initialSessions={mockSessions} />);

    expect(screen.getByText(/User prefers pnpm/)).toBeDefined();
    expect(screen.getByText(/Primary production mailbox/)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "EMAIL" }));
    expect(screen.queryByText(/User prefers pnpm/)).toBeNull();
    expect(screen.getByText(/Primary production mailbox/)).toBeDefined();
  });

  it("shows empty state when facts list is empty", async () => {
    render(<MemoryTab initialFacts={[]} initialSessions={[]} />);

    expect(screen.getByText("No banked facts yet")).toBeDefined();
  });
});
