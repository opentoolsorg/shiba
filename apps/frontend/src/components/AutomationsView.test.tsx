// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AutomationsView } from "./AutomationsView";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AutomationsView scheduled workspace drafts", () => {
  it("submits a timezone-aware repo-free target and exposes pause/resume", async () => {
    let record = {
      id: "weekly-brief",
      prompt: "Prepare the brief",
      repoUrl: "",
      executionTarget: {
        kind: "artifact-workspace",
        workspaceName: "Sales",
        expectedDeliverables: ["sales/account-brief.md"],
      },
      enabled: true,
      runCount: 0,
      triggers: [{ kind: "schedule" }],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/custom-agents") return Response.json({ agents: [] });
      if (path === "/api/automations" && init?.method === "POST") {
        return Response.json({ automation: record }, { status: 201 });
      }
      if (path === "/api/automations" && (!init?.method || init.method === "GET")) return Response.json({ automations: [record] });
      if (path === "/api/automations/weekly-brief" && init?.method === "PATCH") {
        record = { ...record, enabled: (JSON.parse(String(init.body)) as { enabled: boolean }).enabled };
        return Response.json({ automation: record });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AutomationsView />);

    fireEvent.change(screen.getByLabelText("Workspace name"), { target: { value: "Sales" } });
    fireEvent.change(screen.getByLabelText("Scheduled workspace prompt"), { target: { value: "Prepare a grounded weekly brief" } });
    fireEvent.change(screen.getByLabelText("Workspace schedule cron"), { target: { value: "0 9 * * 1-5" } });
    fireEvent.change(screen.getByLabelText("IANA timezone"), { target: { value: "America/Los_Angeles" } });
    fireEvent.change(screen.getByLabelText("Scheduled workspace deliverables"), { target: { value: "sales/account-brief.md\nsales/outreach-draft.md" } });
    fireEvent.click(screen.getByRole("button", { name: "Create scheduled draft" }));

    await waitFor(() => expect(fetchMock.mock.calls.some((call) => call[0] === "/api/automations" && call[1]?.method === "POST")).toBe(true));
    const createCall = fetchMock.mock.calls.find((call) => call[0] === "/api/automations" && call[1]?.method === "POST");
    const body = JSON.parse(String(createCall?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      prompt: "Prepare a grounded weekly brief",
      executionTarget: {
        kind: "artifact-workspace",
        workspaceName: "Sales",
        expectedDeliverables: ["sales/account-brief.md", "sales/outreach-draft.md"],
      },
      triggers: [{ kind: "schedule", cron: "0 9 * * 1-5", timezone: "America/Los_Angeles" }],
    });
    expect(body).not.toHaveProperty("repoUrl");

    const pause = await screen.findByRole("button", { name: "Pause" });
    fireEvent.click(pause);
    await waitFor(() => expect(fetchMock.mock.calls.some((call) => call[0] === "/api/automations/weekly-brief" && call[1]?.method === "PATCH")).toBe(true));
    expect(fetchMock.mock.calls.find((call) => call[0] === "/api/automations/weekly-brief" && call[1]?.method === "PATCH")?.[1]?.body)
      .toBe(JSON.stringify({ enabled: false }));
  });
});
