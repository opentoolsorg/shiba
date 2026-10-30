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
    expect(await screen.findByText("Launch notes")).toBeTruthy();
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
});
