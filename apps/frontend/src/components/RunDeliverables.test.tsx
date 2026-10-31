// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RunDeliverables } from "./RunDeliverables";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const report = {
  path: "research/report.md",
  mediaType: "text/markdown",
  bytes: 128,
  sha256: "ab".repeat(32),
};

describe("run deliverables", () => {
  it("uses a new revision command after adopting a conflicting saved review, preserving the local draft", async () => {
    const artifact = { ...report, artifactId: "artifact_0123456789abcdef0123456789abcdef", version: 2,
      review: { status: "changes_requested" as const, revision: 1, updatedAt: 10, note: "Original request" } };
    const commands: Array<{ commandId: string; reviewRevision: number }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (!url.endsWith("/revision")) return Response.json({ versions: [] });
      commands.push(JSON.parse(String(init?.body)));
      return commands.length === 1
        ? Response.json({ error: "Review changed.", currentReview: { status: "changes_requested", revision: 2, updatedAt: 20, note: "New saved request" } }, { status: 409 })
        : Response.json({ approvalId: "approval-next" });
    }));
    render(<RunDeliverables runId="latest-run" status="completed" deliverables={[artifact]} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Revision note for research/report.md" }), { target: { value: "My unsaved draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Create revision approval" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Your draft is unchanged."));
    expect((screen.getByRole("textbox", { name: "Revision note for research/report.md" }) as HTMLTextAreaElement).value).toBe("My unsaved draft");
    expect((screen.getByRole("combobox", { name: "Review decision for research/report.md" }) as HTMLSelectElement).value).toBe("changes_requested");
    fireEvent.click(screen.getByRole("button", { name: "Create revision approval" }));
    await screen.findByRole("button", { name: "Revision approval created" });
    expect(commands.map((command) => command.reviewRevision)).toEqual([1, 2]);
    expect(commands[0]?.commandId).toMatch(/^[0-9a-f-]{36}$/);
    expect(commands[1]?.commandId).not.toBe(commands[0]?.commandId);
  });

  it("retains the same revision command for a retry after an uncertain network failure", async () => {
    const artifact = { ...report, artifactId: "artifact_0123456789abcdef0123456789abcdef", version: 2,
      review: { status: "changes_requested" as const, revision: 1, updatedAt: 10, note: "Saved request" } };
    const commands: Array<{ commandId: string; reviewRevision: number }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (!url.endsWith("/revision")) return Response.json({ versions: [] });
      commands.push(JSON.parse(String(init?.body)));
      if (commands.length === 1) throw new Error("Connection lost before a response arrived.");
      return Response.json({ approvalId: "approval-retried" });
    }));
    render(<RunDeliverables runId="latest-run" status="completed" deliverables={[artifact]} />);
    fireEvent.click(screen.getByRole("button", { name: "Create revision approval" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Connection lost"));
    fireEvent.click(screen.getByRole("button", { name: "Create revision approval" }));
    await screen.findByRole("button", { name: "Revision approval created" });
    expect(commands).toHaveLength(2);
    expect(commands[1]?.commandId).toBe(commands[0]?.commandId);
    expect(commands.map((command) => command.reviewRevision)).toEqual([1, 1]);
  });

  it("keeps old runs without requested or captured files unchanged", () => {
    const { container } = render(<RunDeliverables runId="old" status="completed" />);
    expect(container.firstChild).toBeNull();
  });

  it("shows requested files while work is pending without inventing a download", () => {
    render(<RunDeliverables runId="run" status="running" expected={[report.path]} />);
    expect(screen.getByText(report.path)).toBeTruthy();
    expect(screen.getByText("Awaiting captured file")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("preserves the owning session and exact artifact index when downloading", () => {
    render(
      <RunDeliverables
        runId="agent-tool:one/two"
        sessionId="session & one"
        status="completed"
        expected={[report.path, "research/sources.json"]}
        deliverables={[
          { ...report, path: "research/sources.json", mediaType: "application/json" },
          report,
        ]}
      />,
    );
    expect(
      screen.getByRole("link", { name: "Download research/report.md" }).getAttribute("href"),
    ).toBe("/api/runs/agent-tool%3Aone%2Ftwo/deliverables/1?session=session+%26+one");
    expect(
      screen.getByRole("link", { name: "Download research/report.md" }).getAttribute("download"),
    ).toBe("report.md");
    expect(screen.getAllByText(`SHA-256: ${report.sha256}`)).toHaveLength(2);
    expect(screen.getByText(/Review their content/)).toBeTruthy();
  });

  it.each([undefined, "default"])(
    "omits the session query for the default owner (%s)",
    (sessionId) => {
      render(
        <RunDeliverables
          runId="one"
          sessionId={sessionId}
          status="completed"
          deliverables={[report]}
        />,
      );
      expect(screen.getByRole("link").getAttribute("href")).toBe("/api/runs/one/deliverables/0");
    },
  );

  it.each(["error", "cancelled", "unknown", "completed"] as const)(
    "does not call missing files captured on %s runs",
    (status) => {
      render(<RunDeliverables runId="run" status={status} expected={[report.path]} />);
      expect(screen.getByText("Not captured")).toBeTruthy();
      expect(screen.queryByRole("link")).toBeNull();
    },
  );

  it("shows a partial manifest without giving an absent output another file's link", () => {
    render(
      <RunDeliverables
        runId="one"
        status="error"
        expected={["research/missing.md", report.path]}
        deliverables={[report]}
      />,
    );
    expect(screen.getByText("Not captured")).toBeTruthy();
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByRole("link").getAttribute("href")).toBe("/api/runs/one/deliverables/0");
  });

  it("shows source provenance and prior versions, then persists an authenticated-scope revision request", async () => {
    const artifact = {
      ...report,
      artifactId: "artifact_0123456789abcdef0123456789abcdef",
      version: 2,
      sourceRunId: "latest-run",
      provenance: { skills: [{ skillId: "skill-1", version: 4, name: "Research" }] },
      review: { status: "pending_review" as const, revision: 0, updatedAt: 10 },
    };
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (String(url).endsWith("/history?session=session+one"))
          return Response.json({
            artifactId: artifact.artifactId,
            versions: [
              {
                runId: "prior-run",
                index: 0,
                path: report.path,
                version: 1,
                sha256: report.sha256,
                bytes: report.bytes,
                createdAt: 1,
                review: { status: "approved", revision: 2, updatedAt: 20 },
              },
              {
                runId: "latest-run",
                index: 0,
                path: report.path,
                version: 2,
                sha256: report.sha256,
                bytes: report.bytes,
                createdAt: 2,
                review: { status: "pending_review", revision: 0, updatedAt: 10 },
              },
            ],
          });
        if (String(url).includes("/revision?session=session+one"))
          return Response.json({ ok: true, approvalId: "approval-new" });
        return Response.json({ ok: true, deliverable: { review: { status: "changes_requested", note: "Add source citations", revision: 1, updatedAt: 30 } } });
      }),
    );
    render(
      <RunDeliverables
        runId="latest-run"
        sessionId="session one"
        status="completed"
        deliverables={[artifact]}
      />,
    );
    expect(screen.getByText("Version 2 · source run latest-run")).toBeTruthy();
    expect(screen.getByText("Skill: Research v4")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Version history (2)")).toBeTruthy());
    fireEvent.click(screen.getByText("Version history (2)"));
    expect(
      screen.getAllByRole("link", { name: "Download prior version" })[0]?.getAttribute("href"),
    ).toBe("/api/runs/prior-run/deliverables/0?session=session+one");
    fireEvent.change(
      screen.getByRole("combobox", { name: "Review decision for research/report.md" }),
      { target: { value: "changes_requested" } },
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Revision note for research/report.md" }),
      { target: { value: "Add source citations" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save review" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Revision requested."));
    expect(calls[0]?.url).toBe("/api/runs/latest-run/deliverables/0/history?session=session+one");
    expect(calls[1]?.url).toBe("/api/runs/latest-run/deliverables/0/review?session=session+one");
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      status: "changes_requested",
      expectedRevision: 0,
      note: "Add source citations",
    });
    expect(screen.getByRole("button", { name: "Create revision approval" })).toBeTruthy();
    expect(calls).toHaveLength(2); // Saving a review never creates/approves work automatically.
    fireEvent.click(screen.getByRole("button", { name: "Create revision approval" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Review it in Approvals before work starts."));
    expect(calls[2]?.url).toBe("/api/runs/latest-run/deliverables/0/revision?session=session+one");
    expect(JSON.parse(String(calls[2]?.init?.body)).commandId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(String(calls[2]?.init?.body))).toMatchObject({
      artifactId: artifact.artifactId,
      artifactVersion: 2,
      reviewRevision: 1,
    });
    expect(screen.getByRole("button", { name: "Revision approval created" }).hasAttribute("disabled")).toBe(true);
  });

  it("refreshes authoritative review state on load and preserves a stale-tab draft after conflict", async () => {
    const artifact = {
      ...report,
      artifactId: "artifact_0123456789abcdef0123456789abcdef",
      version: 2,
      review: { status: "pending_review" as const, revision: 1, updatedAt: 10 },
    };
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/history")) {
        return Response.json({ artifactId: artifact.artifactId, versions: [{
          runId: "latest-run", index: 0, path: report.path, version: 2,
          sha256: report.sha256, bytes: report.bytes, createdAt: 2,
          review: { status: "approved", revision: 2, updatedAt: 20 },
        }] });
      }
      return Response.json({
        error: "Review changed in another tab.",
        currentReview: { status: "approved", revision: 3, updatedAt: 30, note: "Current server note" },
      }, { status: 409 });
    }));
    render(<RunDeliverables runId="latest-run" status="completed" deliverables={[artifact]} />);
    await waitFor(() => expect(screen.getByText("Current saved review: approved")).toBeTruthy());
    fireEvent.change(screen.getByRole("combobox", { name: "Review decision for research/report.md" }), {
      target: { value: "changes_requested" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Revision note for research/report.md" }), {
      target: { value: "My unsaved draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save review" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Your draft is unchanged."));
    expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({
      status: "changes_requested", expectedRevision: 2, note: "My unsaved draft",
    });
    expect((screen.getByRole("combobox", { name: "Review decision for research/report.md" }) as HTMLSelectElement).value)
      .toBe("changes_requested");
    expect((screen.getByRole("textbox", { name: "Revision note for research/report.md" }) as HTMLTextAreaElement).value)
      .toBe("My unsaved draft");
    expect(screen.getByText("Current saved review: approved · Current server note")).toBeTruthy();
  });
});
