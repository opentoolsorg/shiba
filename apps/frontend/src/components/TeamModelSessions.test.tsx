// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TEAM_MODEL_TEXT_MODEL, teamModelPriceQuoteDigest, type TeamModelStateResponse } from "@shiba/shared";
import { TeamModelSessions } from "./TeamModelSessions";
import { teamModelFixture, TEAM_MODEL_ACTOR, TEAM_MODEL_OPERATOR, TEAM_MODEL_ROOM, TEAM_MODEL_WORKSPACE } from "../team-model-fixtures";
const props = () => ({ workspaceId: TEAM_MODEL_WORKSPACE, roomId: TEAM_MODEL_ROOM, actorId: TEAM_MODEL_ACTOR, messages: [] as Array<{ id: string; author: string; body: string }>, notes: [] as Array<{ id: string; version: 1; sha256: string; title: string; body: string }> });
const deferred = () => { let resolve!: (value: Response) => void; const promise = new Promise<Response>((finish) => { resolve = finish; }); return { promise, resolve }; };
function fixture(initial?: TeamModelStateResponse) {
  let state = initial ?? teamModelFixture().state;
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input); if (init?.method === "GET") return Response.json(state);
    const body = JSON.parse(String(init?.body)); posts.push({ path, body });
    if (path.endsWith("/funding/prepare")) {
      const base = teamModelFixture().grant;
      const { currency: _currency, budgetMicroUsd, ...contractInput } = body;
      const { digest: _digest, ...quote } = { ...base.contract.money!.quote, dispatchUntil: Math.min(base.contract.money!.quote.dispatchUntil, body.expiresAt) };
      const grant = { ...base, state: "draft" as const, version: 1, canActivate: true, canRevoke: true, contract: { ...base.contract, ...contractInput, issuerId: TEAM_MODEL_OPERATOR, money: { ...base.contract.money!, budgetMicroUsd, quote: { ...quote, digest: teamModelPriceQuoteDigest(quote) } } } };
      state = { ...state, grants: [grant] }; return Response.json({ ok: true, workspaceId: state.workspaceId, roomId: state.roomId, grant });
    }
    if (path.endsWith("/activate")) { const grant = { ...state.grants[0]!, state: "active" as const, version: 2, canActivate: false }; state = { ...state, grants: [grant] }; return Response.json({ ok: true, workspaceId: state.workspaceId, roomId: state.roomId, grant }); }
    let turn = state.turns[0] ?? teamModelFixture().turn;
    if (path.endsWith("/turns/prepare")) {
      const money = state.grants[0]!.contract.money!;
      turn = { ...turn, requestedPrompt: body.prompt, messages: [{ role: "system", content: state.grants[0]!.contract.employeeInstructions }, { role: "user", content: body.prompt }], cost: { ...turn.cost!, maximumDebitMicroUsd: money.maximumDebitPerCallMicroUsd, quoteDigest: money.quote.digest, dispatchUntil: money.quote.dispatchUntil } };
    }
    if (path.endsWith("/approve")) turn = { ...turn, version: turn.version + 1, status: "approved", canApprove: false, canExecute: true };
    if (path.endsWith("/execute")) turn = { ...turn, version: turn.version + 1, status: "completed", output: "Fixture model text, not live inference.", canExecute: false, canCancel: false };
    if (path.endsWith("/cancel")) turn = { ...turn, version: turn.version + 1, status: "cancelled", canExecute: false, canApprove: false, canCancel: false };
    state = { ...state, turns: [turn] };
    return Response.json({ ok: true, workspaceId: state.workspaceId, roomId: state.roomId, turn });
  }); vi.stubGlobal("fetch", fetcher);
  return { posts, fetcher, get: () => state, set: (next: TeamModelStateResponse) => { state = next; } };
}
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("explicit bounded team text sessions", () => {
  it("shows requester lifetime capacity without workspace totals", async () => {
    const { state, grant } = teamModelFixture();
    grant.money = { ...grant.money!, capacity: { requesterLimitMicroUsd: 1_000_000, requesterReservedMicroUsd: 123_456, requesterRemainingMicroUsd: 876_544, workspaceLimitMicroUsd: 10_000_000, requesterCanReserveNext: true, workspaceCanReserveNext: true } };
    fixture(state); render(<TeamModelSessions {...props()} />);
    expect(await screen.findByText(/Lifetime requester capacity: limit \$1.000000 · reserved \$0.123456 · remaining \$0.876544/)).toBeTruthy();
    expect(screen.queryByText(/Lifetime workspace capacity:/)).toBeNull();
    expect(screen.getByText(/concurrent reservations or stale state/)).toBeTruthy();
  });
  it("shows workspace totals when supplied to the funder", async () => {
    const { state, grant } = teamModelFixture();
    grant.money = { ...grant.money!, capacity: { requesterLimitMicroUsd: 1_000_000, requesterReservedMicroUsd: 123_456, requesterRemainingMicroUsd: 876_544, workspaceLimitMicroUsd: 10_000_000, workspaceReservedMicroUsd: 2_000_001, workspaceRemainingMicroUsd: 7_999_999, requesterCanReserveNext: true, workspaceCanReserveNext: true } };
    fixture({ ...state, actorId: TEAM_MODEL_OPERATOR, canFund: true }); render(<TeamModelSessions {...props()} actorId={TEAM_MODEL_OPERATOR} />);
    fireEvent.click(await screen.findByText("Operator funding setup"));
    expect(screen.getByText(/Lifetime workspace capacity: limit \$10.000000 · reserved \$2.000001 · remaining \$7.999999/)).toBeTruthy();
  });
  it.each(["requesterCanReserveNext", "workspaceCanReserveNext"] as const)("blocks grant selection and preparation when %s is false", async (exhausted) => {
    const { state, grant } = teamModelFixture();
    grant.money = { ...grant.money!, capacity: { requesterLimitMicroUsd: 1_000_000, requesterReservedMicroUsd: 123_456, requesterRemainingMicroUsd: 876_544, workspaceLimitMicroUsd: 10_000_000, requesterCanReserveNext: true, workspaceCanReserveNext: true, [exhausted]: false } };
    const f = fixture(state); render(<TeamModelSessions {...props()} />);
    const select = await screen.findByLabelText("My text-session funding grant");
    expect(screen.getByRole("option", { name: /Writer fixture/ })).toHaveProperty("disabled", true);
    fireEvent.change(select, { target: { value: grant.id } });
    expect(screen.queryByLabelText("Exact text prompt")).toBeNull();
    expect(screen.getByText(/capacity is exhausted for the next call/)).toBeTruthy();
    expect(f.posts).toEqual([]);
  });
  it("clears a selected grant when a refreshed snapshot no longer fits", async () => {
    const { state, grant } = teamModelFixture();
    const capacity = { requesterLimitMicroUsd: 1_000_000, requesterReservedMicroUsd: 123_456, requesterRemainingMicroUsd: 876_544, workspaceLimitMicroUsd: 10_000_000, requesterCanReserveNext: true, workspaceCanReserveNext: true };
    grant.money = { ...grant.money!, capacity };
    const f = fixture(state); render(<TeamModelSessions {...props()} />);
    fireEvent.change(await screen.findByLabelText("My text-session funding grant"), { target: { value: grant.id } });
    fireEvent.change(screen.getByLabelText("Exact text prompt"), { target: { value: "Prepare this text" } });
    f.set({ ...state, grants: [{ ...grant, money: { ...grant.money, capacity: { ...capacity, workspaceCanReserveNext: false } } }] });
    fireEvent.click(screen.getByRole("button", { name: "Refresh team model state" }));
    await waitFor(() => expect(screen.queryByLabelText("Exact text prompt")).toBeNull());
    expect(screen.getByRole("option", { name: /Writer fixture/ })).toHaveProperty("disabled", true);
    expect(f.posts).toEqual([]);
  });
  it("uses server capability only and selects no funding or sources automatically", async () => {
    const f = fixture(); render(<TeamModelSessions {...props()} />);
    const select = await screen.findByLabelText("My text-session funding grant"); expect(select).toHaveProperty("value", "");
    expect(screen.queryByText("Operator funding setup")).toBeNull(); expect(screen.queryByLabelText("Exact text prompt")).toBeNull();
    expect(f.posts).toEqual([]);
    expect(screen.getByText(/not.*dollar|billed to this deployment/i)).toBeTruthy();
  });
  it("stays unavailable with feature disabled and sends no preparation or model request", async () => {
    const f = fixture({ ...teamModelFixture().state, enabled: false, canFund: false, model: null, grants: [], turns: [] });
    render(<TeamModelSessions {...props()} />); await screen.findByText(/Team model sessions are unavailable/);
    expect(screen.queryByLabelText("My text-session funding grant")).toBeNull(); expect(f.posts).toEqual([]);
  });
  it("requires explicit operator selections and separate exact billing consent", async () => {
    const state = { ...teamModelFixture().state, actorId: TEAM_MODEL_OPERATOR, canFund: true, grants: [] };
    const f = fixture(state); render(<TeamModelSessions {...props()} actorId={TEAM_MODEL_OPERATOR} />);
    fireEvent.click(await screen.findByText("Operator funding setup"));
    expect(screen.getByLabelText("Funded employee")).toHaveProperty("value", ""); expect(screen.getByLabelText("Funded member")).toHaveProperty("value", ""); expect(screen.getByLabelText("Exact Workers AI model")).toHaveProperty("value", "");
    expect(screen.getByLabelText("Maximum quoted inference budget (USD)")).toHaveProperty("value", "");
    const prepare = screen.getByRole("button", { name: "Prepare exact funding review" }); expect(prepare).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByLabelText("Funded employee"), { target: { value: "employee-writer" } }); fireEvent.change(screen.getByLabelText("Funded member"), { target: { value: TEAM_MODEL_ACTOR } }); fireEvent.change(screen.getByLabelText("Exact Workers AI model"), { target: { value: TEAM_MODEL_TEXT_MODEL } });
    fireEvent.change(screen.getByLabelText("Maximum model requests"), { target: { value: "2" } }); fireEvent.change(screen.getByLabelText("Maximum full input bytes per request"), { target: { value: "8192" } }); fireEvent.change(screen.getByLabelText("Maximum output tokens per request"), { target: { value: "256" } }); fireEvent.change(screen.getByLabelText("Funding expiry"), { target: { value: "60" } });
    expect(prepare).toHaveProperty("disabled", true);
    for (const value of ["1.000001", "0.0000001", "1e-2", "-0.1", "0.000001"]) {
      fireEvent.change(screen.getByLabelText("Maximum quoted inference budget (USD)"), { target: { value } }); expect(prepare).toHaveProperty("disabled", true);
    }
    fireEvent.change(screen.getByLabelText("Maximum quoted inference budget (USD)"), { target: { value: "0.100000" } });
    fireEvent.click(prepare); const enable = await screen.findByRole("button", { name: "Enable exact funding grant" }); expect(enable).toHaveProperty("disabled", true); expect(f.posts).toHaveLength(1);
    fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed this exact employee/ })); fireEvent.click(enable);
    await waitFor(() => expect(f.posts).toHaveLength(2)); expect(f.posts[1]?.body).toMatchObject({ expectedVersion: 1, billingConsent: true, reviewed: true });
    expect(f.posts.every((post) => !post.path.endsWith("/execute"))).toBe(true);
    expect(f.posts[0]?.body).toMatchObject({ currency: "USD", budgetMicroUsd: 100_000 });
    expect(screen.getAllByText(/not a Cloudflare invoice cap/).length).toBeGreaterThan(0);
  });
  it("disables new turns after the full USD authorization is consumed while showing its exact cost", async () => {
    const { state, grant, turn } = teamModelFixture();
    grant.contract.money!.budgetMicroUsd = grant.contract.money!.maximumDebitPerCallMicroUsd;
    grant.money = { currency: "USD", authorizedDebitMicroUsd: grant.contract.money!.budgetMicroUsd, remainingBudgetMicroUsd: 0, reportedQuotedMicroUsd: 6, unknownReservedMicroUsd: 0 };
    grant.unavailableReason = "team_model_budget_insufficient";
    state.turns = [{ ...turn, status: "approved", canApprove: false, canExecute: true }];
    const f = fixture(state); render(<TeamModelSessions {...props()} />);
    await screen.findByLabelText("My text-session funding grant");
    expect(screen.getByRole("option", { name: /Writer fixture/ })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Execute approved model turn" })).toHaveProperty("disabled", true);
    expect(screen.getByText(/remaining authorization \$0.000000/)).toBeTruthy(); expect(screen.queryByLabelText("Exact text prompt")).toBeNull(); expect(f.posts).toEqual([]);
  });
  it("keeps legacy output readable but never enables amountless model work", async () => {
    const { state, grant, turn } = teamModelFixture(); delete grant.contract.money; delete grant.money; delete turn.cost;
    grant.unavailableReason = "team_model_budget_upgrade_required";
    state.turns = [{ ...turn, status: "completed", output: "Legacy source-authorized text", canApprove: false, canExecute: false }];
    const f = fixture(state); render(<TeamModelSessions {...props()} />);
    await screen.findByText("Legacy source-authorized text"); expect(screen.getByText(/Legacy allowance: no USD budget was approved/)).toBeTruthy();
    expect(screen.getByRole("option", { name: /Writer fixture/ })).toHaveProperty("disabled", true); expect(screen.queryByRole("button", { name: "Execute approved model turn" })).toBeNull(); expect(f.posts).toEqual([]);
  });
  it("retires selected funding exactly at quote expiry before the status poll without hiding completed output", async () => {
    vi.useFakeTimers(); const { state, grant, turn } = teamModelFixture();
    const { digest: _digest, ...quote } = { ...grant.contract.money!.quote, dispatchUntil: Date.now() + 1_000 };
    grant.contract.money!.quote = { ...quote, digest: teamModelPriceQuoteDigest(quote) };
    state.turns = [{ ...turn, status: "completed", output: "Output retains source-scoped authority", canApprove: false, canExecute: false }];
    const f = fixture(state); await act(async () => { render(<TeamModelSessions {...props()} />); });
    fireEvent.change(screen.getByLabelText("My text-session funding grant"), { target: { value: grant.id } }); expect(screen.getByLabelText("Exact text prompt")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_001); });
    expect(screen.queryByLabelText("Exact text prompt")).toBeNull(); expect(screen.getByText("Output retains source-scoped authority")).toBeTruthy(); expect(f.posts).toEqual([]);
  });
  it("prepares then separately reviews and executes exact member input", async () => {
    const f = fixture(); render(<TeamModelSessions {...props()} />);
    fireEvent.change(await screen.findByLabelText("My text-session funding grant"), { target: { value: teamModelFixture().grant.id } });
    fireEvent.change(screen.getByLabelText("Exact text prompt"), { target: { value: "Write a short fixture summary." } });
    fireEvent.click(screen.getByRole("button", { name: "Prepare exact text turn for review" }));
    const approve = await screen.findByRole("button", { name: "Approve exact text input" }); expect(approve).toHaveProperty("disabled", true); expect(f.posts).toHaveLength(1);
    expect(f.posts[0]?.body).toMatchObject({ grantId: teamModelFixture().grant.id, expectedGrantVersion: 2, prompt: "Write a short fixture summary.", messageIds: [], memoryRefs: [] });
    expect(screen.getByText("Draft plain text only. No tools.")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed the complete exact model input/ })); fireEvent.click(approve);
    const execute = await screen.findByRole("button", { name: "Execute approved model turn" }); expect(f.posts).toHaveLength(2); fireEvent.click(execute); fireEvent.click(execute);
    await screen.findByText("Fixture model text, not live inference."); expect(f.posts.filter((post) => post.path.endsWith("/execute"))).toHaveLength(1);
  });
  it("blocks every approved turn on a grant after a lost execute response", async () => {
    const { state, turn } = teamModelFixture(); const approved = { ...turn, status: "approved" as const, canApprove: false, canExecute: true };
    state.turns = [approved, { ...approved, id: "second-turn" }]; const f = fixture(state), original = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (input, init) => { if (String(input).endsWith("/execute")) { f.posts.push({ path: String(input), body: JSON.parse(String(init?.body)) }); throw new TypeError("Fixture lost response"); } return original(input, init); });
    render(<TeamModelSessions {...props()} />); const execute = await screen.findAllByRole("button", { name: "Execute approved model turn" });
    fireEvent.click(execute[0]!); await screen.findByRole("alert");
    for (const button of screen.getAllByRole("button", { name: "Execute approved model turn" })) { expect(button).toHaveProperty("disabled", true); fireEvent.click(button); }
    expect(f.posts).toHaveLength(1);
    f.set({ ...state, turns: [{ ...approved, status: "completed", canExecute: false }, state.turns[1]!] });
    fireEvent.click(screen.getByRole("button", { name: "Refresh team model state" }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Execute approved model turn" })).toHaveLength(1));
    expect(screen.getByRole("button", { name: "Execute approved model turn" })).toHaveProperty("disabled", false);
  });
  it("clears cached input and output on current source revocation", async () => {
    const { state, turn } = teamModelFixture(), note = { id: "ctx_note", version: 1 as const, sha256: "1".repeat(64), title: "Selected note", body: "Source body" };
    state.turns = [{ ...turn, status: "completed", canApprove: false, canCancel: false, output: "Private scoped fixture output", sources: [{ ...note, kind: "note", author: TEAM_MODEL_ACTOR }] }];
    fixture(state); const view = render(<TeamModelSessions {...props()} notes={[note]} />); await screen.findByText("Private scoped fixture output");
    view.rerender(<TeamModelSessions {...props()} notes={[]} />);
    expect(screen.queryByText("Private scoped fixture output")).toBeNull(); expect(screen.queryByText("Source body")).toBeNull();
  });
  it("hides pending review input at its exact dispatch deadline before the next status poll", async () => {
    const { state, turn } = teamModelFixture(), at = Date.now(); turn.expiresAt = at + 1_000;
    state.turns = [turn]; vi.useFakeTimers(); vi.setSystemTime(at); const f = fixture(state);
    await act(async () => { render(<TeamModelSessions {...props()} />); });
    expect(screen.getByText("Draft plain text only. No tools.")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_001); });
    expect(screen.queryByText("Draft plain text only. No tools.")).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /I reviewed the complete exact model input/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Stop this text turn" })).toHaveProperty("disabled", false); expect(f.posts).toEqual([]);
  });
  it("keeps completed output past the dispatch deadline but hides it at exact funding expiry", async () => {
    const { state, turn } = teamModelFixture(), at = Date.now(); turn.expiresAt = at + 1_000; state.grants[0]!.contract.expiresAt = at + 2_000;
    state.turns = [{ ...turn, status: "completed", canApprove: false, canExecute: false, canCancel: true, output: "Funding-scoped private text" }];
    vi.useFakeTimers(); vi.setSystemTime(at); const f = fixture(state); await act(async () => { render(<TeamModelSessions {...props()} />); });
    expect(screen.getByText("Funding-scoped private text")).toBeTruthy(); await act(async () => { await vi.advanceTimersByTimeAsync(1_001); });
    expect(screen.getByText("Funding-scoped private text")).toBeTruthy(); await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.queryByText("Funding-scoped private text")).toBeNull(); expect(screen.queryByText("Draft plain text only. No tools.")).toBeNull();
    expect(screen.getByRole("button", { name: "Stop this text turn" })).toHaveProperty("disabled", false); expect(f.posts).toEqual([]);
  });
  it("keeps server-authorized Stop available after funding is revoked", async () => {
    const { state, turn } = teamModelFixture(); state.grants = [{ ...state.grants[0]!, state: "revoked", version: 3 }]; state.turns = [{ ...turn, status: "approved", canApprove: false, canExecute: false, canCancel: true }];
    const f = fixture(state); render(<TeamModelSessions {...props()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Stop this text turn" })); await waitFor(() => expect(f.posts).toHaveLength(1)); expect(f.posts[0]?.path).toMatch(/\/cancel$/);
    expect(screen.queryByRole("button", { name: "Execute approved model turn" })).toBeNull();
  });
  it("refreshes the exact Stop version independently while execute is pending and ignores late output", async () => {
    const { state, turn } = teamModelFixture(); state.turns = [{ ...turn, status: "approved", canApprove: false, canExecute: true }];
    const f = fixture(state), held = deferred(), original = f.fetcher.getMockImplementation()!;
    let executeSignal: AbortSignal | null = null, cancelSignal: AbortSignal | null = null;
    f.fetcher.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/execute")) {
        executeSignal = init?.signal as AbortSignal; f.set({ ...state, turns: [{ ...state.turns[0]!, status: "running", version: 2, canExecute: false }] }); return held.promise;
      }
      if (String(input).endsWith("/cancel")) {
        cancelSignal = init?.signal as AbortSignal; f.posts.push({ path: String(input), body: JSON.parse(String(init?.body)) });
        const next = { ...state.turns[0]!, status: "unknown", version: 3, canExecute: false, output: null };
        return Response.json({ ok: true, workspaceId: TEAM_MODEL_WORKSPACE, roomId: TEAM_MODEL_ROOM, turn: next });
      }
      return original(input, init);
    });
    render(<TeamModelSessions {...props()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Execute approved model turn" }));
    const stop = screen.getByRole("button", { name: "Stop this text turn" }); expect(stop).toHaveProperty("disabled", false); fireEvent.click(stop);
    await waitFor(() => expect(f.posts).toHaveLength(1)); expect(f.posts[0]?.body).toEqual({ expectedVersion: 2 });
    expect(cancelSignal).not.toBe(executeSignal);
    await screen.findByText(/Cancellation state returned/);
    await act(async () => held.resolve(Response.json({ ok: true, workspaceId: TEAM_MODEL_WORKSPACE, roomId: TEAM_MODEL_ROOM, turn: { ...turn, version: 3, status: "completed", output: "Late provider output must stay hidden" } })));
    expect(screen.queryByText("Late provider output must stay hidden")).toBeNull();
    expect(screen.queryByRole("button", { name: "Execute approved model turn" })).toBeNull();
    expect(screen.getByText(/Execution response unconfirmed/)).toBeTruthy();
  });
  it("discards delayed A execution output after a workspace and actor switch", async () => {
    const { state, turn } = teamModelFixture(); state.turns = [{ ...turn, status: "approved", canApprove: false, canExecute: true }]; const f = fixture(state), held = deferred(), original = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (input, init) => String(input).endsWith("/execute") ? held.promise : original(input, init));
    const view = render(<TeamModelSessions {...props()} />); fireEvent.click(await screen.findByRole("button", { name: "Execute approved model turn" }));
    f.set({ ...state, workspaceId: `ws_${"d".repeat(24)}`, actorId: "other@example.test", grants: [], turns: [], enabled: false });
    view.rerender(<TeamModelSessions {...props()} workspaceId={`ws_${"d".repeat(24)}`} actorId="other@example.test" />);
    await act(async () => held.resolve(Response.json({ ok: true, workspaceId: TEAM_MODEL_WORKSPACE, roomId: TEAM_MODEL_ROOM, turn: { ...turn, status: "completed", output: "Old A private output" } })));
    expect(screen.queryByText("Old A private output")).toBeNull(); expect(screen.queryByText(/Model turn state returned/)).toBeNull();
  });
  it("clears all cached state on current access denial without showing raw errors", async () => {
    const { state, turn } = teamModelFixture(); state.turns = [{ ...turn, status: "completed", output: "Scoped old output" }]; const f = fixture(state);
    render(<TeamModelSessions {...props()} />); await screen.findByText("Scoped old output"); f.fetcher.mockResolvedValue(Response.json({ error: "fixture server secret" }, { status: 403 })); fireEvent.click(screen.getByRole("button", { name: "Refresh team model state" }));
    await screen.findByRole("alert"); expect(screen.queryByText("Scoped old output")).toBeNull(); expect(screen.queryByText("fixture server secret")).toBeNull();
  });
});
