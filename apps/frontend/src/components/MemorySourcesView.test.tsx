// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemorySourcesView } from "./MemorySourcesView";

const source = {
  id: "memsrc_1",
  title: "Launch notes",
  content: "Ship the app after QA approves the release.",
  kind: "document",
  referenceUrl: "https://docs.example.test/launch",
  createdAt: 1,
  updatedAt: 1,
  retentionDays: 365,
  expiresAt: Date.now() + 86_400_000,
  disabledAt: null,
};
const json = (value: unknown) => Response.json(value);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MemorySourcesView", () => {
  it("uploads actual TXT/Markdown bytes, shows only acknowledged ready versions, and clears stale recall", async () => {
    const file = new File(["# Brand\nOrion launch"], "brand.md", { type: "text/markdown" });
    const managed = { ...source, title: "brand.md", version: 1, sha256: "ab".repeat(32), ingestion: { state: "ready", filename: "brand.md", mediaType: "text/markdown", bytes: file.size } };
    let uploaded = false;
    const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/memory/sources/upload") { uploaded = true; return json({ source: managed }); }
      if (path === "/api/memory/sources") return json({ sources: uploaded ? [managed] : [] });
      if (path.startsWith("/api/memory/recall")) return json({ hits: [{ ...source, score: 1 }] });
      return json({ projects: [] });
    });
    vi.stubGlobal("fetch", fetcher);
    render(<MemorySourcesView />);
    await screen.findByText(/No private sources saved/);
    fireEvent.change(screen.getByLabelText("QUERY"), { target: { value: "launch" } });
    fireEvent.click(screen.getByRole("button", { name: "Recall" }));
    await screen.findByLabelText("Memory recall results");
    fireEvent.change(screen.getByLabelText("TXT or Markdown file"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload file" }));
    await screen.findByText(/Immutable version ready/);
    expect(screen.getByText(/Extraction: ready · version 1/)).toBeTruthy();
    expect(screen.queryByLabelText("Memory recall results")).toBeNull();
    const request = fetcher.mock.calls.find(([path]) => String(path).endsWith("/upload"));
    expect(request?.[1]?.body).toBe(file);
    expect(request?.[1]?.headers).toEqual({ "Content-Type": "text/markdown", "X-Source-Filename": "brand.md" });
  });

  it("shows failed uploads honestly and persists pending file cleanup across reload", async () => {
    let cleanup = true;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/memory/sources/upload") return Response.json({ error: "File is not valid UTF-8." }, { status: 400 });
      if (path.endsWith("/memsrc_1") && init?.method === "DELETE") { cleanup = false; return json({ cleanup: "complete" }); }
      if (path === "/api/memory/sources") return json({ sources: [], cleanupPending: cleanup ? [{ id: "memsrc_1", filename: "removed.md" }] : [] });
      return json({ projects: [] });
    });
    vi.stubGlobal("fetch", fetcher);
    render(<MemorySourcesView />);
    await screen.findByLabelText("Pending file cleanup");
    fireEvent.change(screen.getByLabelText("TXT or Markdown file"), { target: { files: [new File(["bad bytes"], "bad.md")] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload file" }));
    await screen.findByText("File is not valid UTF-8.");
    expect(screen.queryByText(/Extraction: ready/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry file cleanup" }));
    await screen.findByText("Stored file cleanup complete.");
    expect(screen.queryByLabelText("Pending file cleanup")).toBeNull();
  });

  it("preserves managed edits on stale-version conflict and refreshes CAS only for another human save", async () => {
    const managed = { ...source, version: 1, sha256: "ab".repeat(32), ingestion: { state: "ready", filename: "brand.md", mediaType: "text/markdown", bytes: 20 } };
    let current = managed;
    const edits: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/memory/sources") return json({ sources: [current] });
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        edits.push(body);
        if (edits.length === 1) {
          current = { ...managed, version: 2, content: "Other reviewer's content" };
          return Response.json({ error: "Source changed.", currentSource: current }, { status: 409 });
        }
        current = { ...current, version: 3, content: String(body.content) };
        return json({ source: current });
      }
      return json({ projects: [] });
    }));
    render(<MemorySourcesView />);
    fireEvent.click(await screen.findByRole("button", { name: "Inspect / edit" }));
    fireEvent.change(screen.getByLabelText("TEXT TO REMEMBER"), { target: { value: "My corrected facts" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText(/Current source refreshed. Your text is unchanged/);
    expect(edits).toHaveLength(1);
    expect(edits[0]?.expectedVersion).toBe(1);
    expect((screen.getByLabelText("TEXT TO REMEMBER") as HTMLTextAreaElement).value).toBe("My corrected facts");
    expect(screen.getByText(/Current source version: 2/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Memory source updated.");
    expect(edits[1]).toMatchObject({ expectedVersion: 2, content: "My corrected facts" });
    expect(current.version).toBe(3);
  });

  it("loads, inspects, edits, disables, and searches source-attributed untrusted memory", async () => {
    let current = source;
    const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const body =
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as Record<string, unknown>)
            : undefined;
        requests.push({ url, method, body });
        if (url === "/api/memory/sources" && method === "GET") return json({ sources: [current] });
        if (url === "/api/memory/sources/memsrc_1" && method === "PATCH") {
          current = {
            ...current,
            ...body,
            disabledAt: body?.enabled === false ? Date.now() : current.disabledAt,
          } as typeof source;
          return json({ source: current });
        }
        if (url.startsWith("/api/memory/recall?"))
          return json({
            hits: [
              { ...current, score: 1, trust: "untrusted", context: "UNTRUSTED REFERENCE DATA" },
            ],
          });
        return json({ sources: [] });
      }),
    );

    render(<MemorySourcesView />);
    expect(await screen.findByRole("heading", { name: "Launch notes" })).toBeTruthy();
    fireEvent.click(screen.getByText("Inspect stored text"));
    expect(screen.getByText("Ship the app after QA approves the release.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Inspect / edit" }));
    fireEvent.change(screen.getByLabelText("TITLE"), { target: { value: "Updated launch notes" } });
    fireEvent.change(screen.getByLabelText("TEXT TO REMEMBER"), {
      target: { value: "Ship only after the signed QA approval." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(
        requests.some(
          (request) => request.method === "PATCH" && request.body?.title === "Updated launch notes",
        ),
      ).toBe(true),
    );

    fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    await waitFor(() =>
      expect(
        requests.some((request) => request.method === "PATCH" && request.body?.enabled === false),
      ).toBe(true),
    );
    fireEvent.change(screen.getByLabelText("QUERY"), { target: { value: "QA approval" } });
    fireEvent.click(screen.getByRole("button", { name: "Recall" }));
    expect(await screen.findByLabelText("Memory recall results")).toBeTruthy();
    expect(
      requests.some((request) => request.url.startsWith("/api/memory/recall?q=QA%20approval")),
    ).toBe(true);
  });

  it("creates a project with an explicitly selected source and reloads it", async () => {
    const project = { id: "memproj_aaaaaaaaaaaaaaaaaaaaaaaa", name: "Launch", purpose: "Ship safely", sourceIds: [source.id], defaultCustomAgentId: "employee-7", defaultHarness: "opencode", version: 1, createdAt: 1, updatedAt: 1, disabledAt: null };
    let projects: typeof project[] = [];
    const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      requests.push({ url, method, body });
      if (url === "/api/memory/sources") return json({ sources: [source] });
      if (url === "/api/memory/projects" && method === "GET") return json({ projects });
      if (url === "/api/memory/projects" && method === "POST") { projects = [{ ...project, ...body } as typeof project]; return json({ project: projects[0] }); }
      return json({});
    }));
    render(<MemorySourcesView />);
    fireEvent.change(await screen.findByLabelText("Project name"), { target: { value: "Launch" } });
    fireEvent.change(screen.getByLabelText("Project purpose"), { target: { value: "Ship safely" } });
    fireEvent.click(screen.getByLabelText("Launch notes"));
    fireEvent.change(screen.getByLabelText("Default employee ID"), { target: { value: "employee-7" } });
    fireEvent.change(screen.getByLabelText("Default harness"), { target: { value: "opencode" } });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    expect(await screen.findByText("v1 · 1 sources · active")).toBeTruthy();
    expect(requests.some((request) => request.method === "POST" && request.body?.sourceIds && (request.body.sourceIds as string[]).includes(source.id))).toBe(true);
    expect(requests.filter((request) => request.url === "/api/memory/projects" && request.method === "GET").length).toBeGreaterThanOrEqual(2);
  });
});
