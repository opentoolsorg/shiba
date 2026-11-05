// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PersonalExecutionControls } from "./PersonalExecutionControls";
import { PERSONAL_ACTOR, PERSONAL_WORKSPACE } from "../personal-execution-fixtures";
import type { PersonalHarnessRun } from "../personal-execution-client";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function fixture() {
  const run: PersonalHarnessRun = { sandboxId: "personal-fixture-run", events: [], diff: "", grantVersion: 2, machineRevision: 3,
    canAllow: true, canDeny: true, canInterrupt: true,
    approvals: [{ requestId: "permission-fixture", kind: "tool", title: "Read the approved repository file", detail: "Read README.md in this repository.", createdAt: Date.now(), actionHash: "a".repeat(64), expiresAt: Date.now() + 60_000, reviewIncomplete: false }] };
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === "GET") return Response.json({ runs: [run] });
    const body = JSON.parse(String(init?.body)); posts.push({ path, body });
    return Response.json({ ok: true, actionHash: body.actionHash, expiresAt: body.expiresAt });
  });
  vi.stubGlobal("fetch", fetcher);
  return { run, posts, fetcher };
}
function show() { return render(<PersonalExecutionControls workspaceId={PERSONAL_WORKSPACE} actorId={PERSONAL_ACTOR} />); }

describe("personal CLI exact human decisions", () => {
  it("requires an explicit single click bound to the complete source hash and expiry", async () => {
    const f = fixture(); show();
    const allow = await screen.findByRole("button", { name: "Allow this request" });
    expect(f.posts).toEqual([]); fireEvent.click(allow); fireEvent.click(allow);
    await waitFor(() => expect(f.posts).toHaveLength(1));
    expect(f.posts[0]).toEqual({ path: "/api/personal-execution/harness/decide", body: {
      sandboxId: f.run.sandboxId, requestId: f.run.approvals[0]!.requestId, actionHash: "a".repeat(64),
      expiresAt: f.run.approvals[0]!.expiresAt, grantVersion: 2, machineRevision: 3, decision: "allow" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Allow this request" })).toHaveProperty("disabled", true));
    expect(screen.getByRole("button", { name: "Deny this request" })).toHaveProperty("disabled", true);
    expect(screen.queryByRole("button", { name: /approve all/i })).toBeNull();
  });
  it.each(["incomplete", "oversize", "missing-hash", "expired", "no-authority"])("disables Allow for %s without inferring authority", async (variant) => {
    const f = fixture(), approval = f.run.approvals[0]!;
    if (variant === "incomplete") approval.reviewIncomplete = true;
    if (variant === "oversize") approval.detail = "x".repeat(2_001);
    if (variant === "missing-hash") approval.actionHash = "";
    if (variant === "expired") approval.expiresAt = Date.now() - 1;
    if (variant === "no-authority") f.run.canAllow = false;
    show(); const allow = await screen.findByRole("button", { name: "Allow this request" });
    expect(allow).toHaveProperty("disabled", true); fireEvent.click(allow); expect(f.posts).toEqual([]);
  });
  it("keeps server-authorized Stop available with stale grant and no permission authority", async () => {
    const f = fixture(); f.run.canAllow = false; f.run.canDeny = false; f.run.approvals = [];
    show(); fireEvent.click(await screen.findByRole("button", { name: "Stop my local process" }));
    await waitFor(() => expect(f.posts).toHaveLength(1));
    expect(f.posts[0]).toEqual({ path: "/api/personal-execution/harness/control", body: { sandboxId: f.run.sandboxId, grantVersion: 2, machineRevision: 3, interrupt: true } });
    expect(screen.queryByRole("button", { name: "Allow this request" })).toBeNull();
  });
  it("does not automatically resend an uncertain decision after a fresh read", async () => {
    const f = fixture(), base = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (input, init) => {
      if (init?.method === "POST") { f.posts.push({ path: String(input), body: JSON.parse(String(init.body)) }); throw new Error("Unknown fixture transport outcome"); }
      return base(input, init);
    });
    show(); fireEvent.click(await screen.findByRole("button", { name: "Allow this request" }));
    await screen.findByText(/Control outcome could not be confirmed/);
    fireEvent.click(screen.getByRole("button", { name: "Reload my local permissions" }));
    await screen.findByRole("button", { name: "Allow this request" });
    expect(screen.getByRole("button", { name: "Allow this request" })).toHaveProperty("disabled", true);
    expect(f.posts).toHaveLength(1);
  });
  it("sends no Stop without an explicit server capability", async () => {
    const f = fixture(); f.run.canInterrupt = false; show();
    const stop = await screen.findByRole("button", { name: "Stop my local process" });
    expect(stop).toHaveProperty("disabled", true); fireEvent.click(stop); expect(f.posts).toEqual([]);
  });
  it("treats a mismatched permission receipt as uncertain and cannot click it again", async () => {
    const f = fixture(), base = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (input, init) => init?.method === "POST" ? Response.json({ ok: true, actionHash: "b".repeat(64), expiresAt: f.run.approvals[0]!.expiresAt }) : base(input, init));
    show(); fireEvent.click(await screen.findByRole("button", { name: "Allow this request" }));
    await screen.findByText(/Control outcome could not be confirmed/);
    fireEvent.click(screen.getByRole("button", { name: "Reload my local permissions" }));
    expect(await screen.findByRole("button", { name: "Allow this request" })).toHaveProperty("disabled", true);
  });
  it("drops a delayed permission completion after workspace and actor change", async () => {
    let finish!: (response: Response) => void;
    const hash = "a".repeat(64), expiry = Date.now() + 60_000, posts: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const workspace = new Headers(init?.headers).get("X-Shiba-Workspace");
      if (init?.method === "POST") { posts.push(JSON.parse(String(init.body))); return new Promise<Response>((resolve) => { finish = resolve; }); }
      return Response.json({ runs: workspace === PERSONAL_WORKSPACE ? [{ sandboxId: "scope-a-process", grantVersion: 1, machineRevision: 1,
        canAllow: true, canDeny: true, canInterrupt: true, approvals: [{ requestId: "scope-a-permission", kind: "tool", title: "Private A request",
          detail: "Private A detail", createdAt: Date.now(), actionHash: hash, expiresAt: expiry, reviewIncomplete: false }] }] : [] });
    }));
    const view = show(); fireEvent.click(await screen.findByRole("button", { name: "Allow this request" }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    view.rerender(<PersonalExecutionControls workspaceId={"ws_" + "b".repeat(24)} actorId="other@example.test" />);
    await act(async () => { finish(Response.json({ ok: true, actionHash: hash, expiresAt: expiry })); });
    expect(screen.queryByText("Private A detail")).toBeNull(); expect(screen.queryByText(/Control request sent/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Allow this request" })).toBeNull(); expect(posts).toHaveLength(1);
  });
});
