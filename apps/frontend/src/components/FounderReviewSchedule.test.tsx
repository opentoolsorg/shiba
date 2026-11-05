// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FounderReviewScheduleRecord } from "@shiba/shared";
import { FounderReviewSchedule } from "./FounderReviewSchedule";

const base = "/api/founder-skills/founder-stripe-revenue-pulse/review-schedule";
const options = { employees: [{ id: "employee-a", version: 2, name: "Revenue reviewer" }], skill: { id: "skill-a", version: 3, name: "Revenue facts" } };
const draft: FounderReviewScheduleRecord = { id: "schedule-a", version: 1, digest: "a".repeat(64), state: "draft", reviewExpiresAt: Date.now() + 900_000, nextDueAt: Date.now() + 3_600_000,
  contract: { format: "shiba.founder-review.v1", mode: "review-draft", orgId: "self-hosted", ownerId: "owner@example.test", ownerAccountId: "native-owner", libraryId: "founder-stripe-revenue-pulse", employeeId: "employee-a", employeeVersion: 2, skillId: "skill-a", skillVersion: 3,
    cadence: "daily", localTime: "09:00", timezone: "UTC", expiresAt: Date.now() + 86_400_000, destination: "private-dashboard", allowedTools: [], provider: null, recipeSha256: "b".repeat(64), membership: null,
    employeeConfig: '{"name":"Revenue reviewer","instructions":"Private profile"}', employeeName: "Revenue reviewer", skillInstructions: "State assumptions.", skillName: "Revenue facts", skillSource: null, cron: "0 9 * * *", task: "Prepare a revenue task draft.", requiredSources: ["stripe"] } };
const props = { libraryId: "founder-stripe-revenue-pulse", name: "Revenue", suggested: { timezone: "UTC" }, onClose: vi.fn() };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("FounderReviewSchedule", () => {
  it("requires explicit profile selection, prepares a bounded no-tool scope and enables only after exact review", async () => {
    const writes: Array<{ path: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/options")) return Response.json(options);
      if (init?.method !== "POST") return Response.json({ schedule: null, occurrences: [] });
      writes.push({ path, body: JSON.parse(String(init?.body)) });
      return Response.json({ schedule: path.endsWith("/enable") ? { ...draft, version: 2, state: "enabled" } : draft, occurrences: [] });
    }));
    render(<FounderReviewSchedule {...props} />);
    await screen.findByRole("combobox", { name: "Employee profile" });
    const prepare = screen.getByRole("button", { name: "Prepare review draft configuration" }) as HTMLButtonElement;
    expect(prepare.disabled).toBe(true);
    fireEvent.change(screen.getByRole("combobox", { name: "Employee profile" }), { target: { value: "employee-a" } });
    fireEvent.click(prepare);
    await screen.findByText(`Review digest: ${draft.digest}`);
    expect(writes).toEqual([{ path: base, body: expect.objectContaining({ mode: "review-draft", employeeVersion: 2, skillVersion: 3, provider: null, allowedTools: [], destination: "private-dashboard", expectedVersion: 0 }) }]);
    const enable = screen.getByRole("button", { name: "Enable review drafts" }) as HTMLButtonElement;
    expect(enable.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed these exact versions/ }));
    fireEvent.click(enable);
    await screen.findByText("State: enabled · revision 2");
    expect(writes[1]).toEqual({ path: `${base}/enable`, body: { expectedVersion: 1, digest: draft.digest, reviewed: true } });
    expect(vi.mocked(fetch).mock.calls.every(([path]) => String(path).startsWith(base))).toBe(true);
    expect(screen.getByText(/does not run an employee, call a model/)).toBeTruthy();
  });
  it("uses the exact CAS for stop controls and displays storage-only receipts", async () => {
    let current = { ...draft, state: "enabled" as const, version: 2 } as FounderReviewScheduleRecord;
    const receipt = { id: "schedule-a:2:1000", scheduleId: "schedule-a", scheduleVersion: 2, digest: draft.digest, scheduledAt: 1000, createdAt: 2000, status: "pending", task: "No fetched data. Draft only." };
    const writes: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      if (String(input).endsWith("/options")) return Response.json(options);
      if (init?.method === "POST") { writes.push(JSON.parse(String(init.body))); current = { ...current, state: "paused", version: 3 }; }
      return Response.json({ schedule: current, occurrences: [{ ...receipt, status: current.state === "paused" ? "cancelled" : "pending" }] });
    }));
    render(<FounderReviewSchedule {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Pause review drafts" }));
    await screen.findByText("State: paused · revision 3");
    expect(writes).toEqual([{ expectedVersion: 2, digest: draft.digest, reviewed: true }]);
    expect(screen.getByText(/cancelled/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Resume review drafts" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("never enables after a failed preparation and exposes unavailable app execution honestly", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo, init?: RequestInit) => String(input).endsWith("/options") ? Response.json(options) : init?.method === "POST" ? Response.json({ error: "employee_version_changed" }, { status: 409 }) : Response.json({ schedule: null, occurrences: [] })));
    render(<FounderReviewSchedule {...props} />);
    fireEvent.change(await screen.findByRole("combobox", { name: "Employee profile" }), { target: { value: "employee-a" } });
    fireEvent.click(screen.getByRole("button", { name: "Prepare review draft configuration" }));
    expect((await screen.findByRole("alert")).textContent).toContain("employee_version_changed");
    expect(screen.queryByRole("button", { name: "Enable review drafts" })).toBeNull();
    expect(screen.getByText(/Scheduled connector execution still requires an explicit account/)).toBeTruthy();
  });
  it("does not fetch an execution provider or allow preparation without an active skill", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => String(input).endsWith("/options") ? Response.json({ ...options, skill: null }) : Response.json({ schedule: null, occurrences: [] })));
    render(<FounderReviewSchedule {...props} />);
    await screen.findByText(/Install, review and activate this founder skill/);
    expect((screen.getByRole("button", { name: "Prepare review draft configuration" }) as HTMLButtonElement).disabled).toBe(true);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });
  it("pins workspace headers, aborts A requests and discards late A receipts after switching to B", async () => {
    let finish!: (response: Response) => void;
    const pendingA = new Promise<Response>((resolve) => { finish = resolve; });
    const calls: Array<{ workspace: string | null; signal: AbortSignal | null | undefined }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const workspace = new Headers(init?.headers).get("X-Shiba-Workspace"); calls.push({ workspace, signal: init?.signal });
      if (workspace === "team-a" && !String(input).endsWith("/options")) return pendingA;
      if (String(input).endsWith("/options")) return Response.json(options);
      return Response.json({ schedule: null, occurrences: [] });
    }));
    const { rerender } = render(<FounderReviewSchedule {...props} workspaceId="team-a" />);
    await waitFor(() => expect(calls).toHaveLength(2));
    rerender(<FounderReviewSchedule {...props} workspaceId="team-b" />);
    await waitFor(() => expect(calls).toHaveLength(4));
    expect(calls.filter((call) => call.workspace === "team-a").every((call) => call.signal?.aborted)).toBe(true);
    await act(async () => finish(Response.json({ schedule: draft, occurrences: [] })));
    expect(screen.queryByText(/Private profile/)).toBeNull();
    expect(screen.queryByText(`Review digest: ${draft.digest}`)).toBeNull();
    expect(calls.map((call) => call.workspace)).toEqual(["team-a", "team-a", "team-b", "team-b"]);
  });
  it("refreshes a later due receipt and removes cached instructions after confirmed access loss", async () => {
    let revoked = false, due = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => {
      if (String(input).endsWith("/options")) return Response.json(options);
      if (revoked) return Response.json({ error: "workspace_removed" }, { status: 404 });
      return Response.json({ schedule: { ...draft, state: "enabled", version: 2 }, occurrences: due ? [{ id: "new-due", scheduleId: draft.id, scheduleVersion: 2, digest: draft.digest, scheduledAt: 1000, createdAt: 2000, status: "pending", task: "Later private draft" }] : [] });
    }));
    render(<FounderReviewSchedule {...props} workspaceId="team-a" />);
    await screen.findByText(`Review digest: ${draft.digest}`);
    due = true; fireEvent.click(screen.getByRole("button", { name: "Refresh review drafts" }));
    await screen.findByText("Later private draft");
    revoked = true; fireEvent.click(screen.getByRole("button", { name: "Refresh review drafts" }));
    await screen.findByRole("alert");
    expect(screen.queryByText("Later private draft")).toBeNull();
    expect(screen.queryByText(`Review digest: ${draft.digest}`)).toBeNull();
    expect(screen.queryByText(/Private profile/)).toBeNull();
  });
  it("explains the native-account prerequisite without offering an Access identity fallback", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "native_founder_schedule_required" }, { status: 403 })));
    render(<FounderReviewSchedule {...props} />);
    expect((await screen.findByRole("alert")).textContent).toContain("Sign in with a verified native account");
    expect(screen.queryByRole("button", { name: "Enable review drafts" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Prepare review draft configuration" })).toBeNull();
  });
});
