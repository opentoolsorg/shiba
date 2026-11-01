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
      if (path.startsWith("/api/skills?")) return Response.json({ skills: [] });
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

  it("stores a saved skill snapshot and offers an explicit pin review action", async () => {
    const skill = {
      id: "skill-aaaaaaaaaaaaaaaaaaaaaaaa", version: 3, status: "active", owned: true,
      name: "Evidence rules", sourceUrl: "https://example.test/skill.md", instructions: "Cite every claim.",
      createdAt: 1, updatedAt: 3,
    };
    let record: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/custom-agents") return Response.json({ agents: [] });
      if (path.startsWith("/api/skills?")) return Response.json({ skills: [skill] });
      if (path === "/api/automations" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        record = { ...body, id: "skill-schedule", repoUrl: "", enabled: true, runCount: 0, triggers: [{ kind: "schedule" }] };
        return Response.json({ automation: record }, { status: 201 });
      }
      if (path === "/api/automations" && (!init?.method || init.method === "GET")) return Response.json({ automations: record ? [record] : [] });
      if (path === "/api/automations/skill-schedule" && init?.method === "PATCH") return Response.json({ automation: record });
      return Response.json({ error: "not found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AutomationsView />);
    fireEvent.change(screen.getByLabelText("Scheduled workspace prompt"), { target: { value: "Prepare a sourced draft" } });
    await screen.findByLabelText(`Pin ${skill.name}`);
    fireEvent.click(screen.getByLabelText(`Pin ${skill.name}`));
    fireEvent.click(screen.getByRole("button", { name: "Create scheduled draft" }));
    await waitFor(() => expect(record).not.toBeNull());
    const createBody = JSON.parse(String(fetchMock.mock.calls.find((call) => call[1]?.method === "POST")?.[1]?.body)) as {
      skillPins: { id: string; version: string; source: string; instructions: string; sha256: string }[];
    };
    expect(createBody.skillPins[0]).toMatchObject({ id: skill.id, version: "3", source: skill.sourceUrl, instructions: expect.stringContaining("Cite every claim.") });
    expect(createBody.skillPins[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);

    fireEvent.click(await screen.findByRole("button", { name: "Review current pins" }));
    await waitFor(() => expect(fetchMock.mock.calls.some((call) => call[1]?.method === "PATCH")).toBe(true));
    const reviewBody = JSON.parse(String(fetchMock.mock.calls.find((call) => call[1]?.method === "PATCH")?.[1]?.body)) as Record<string, unknown>;
    expect(reviewBody.reviewSkillPins).toBe(true);
    expect(reviewBody.skillPins).toEqual(createBody.skillPins);
  });
});
