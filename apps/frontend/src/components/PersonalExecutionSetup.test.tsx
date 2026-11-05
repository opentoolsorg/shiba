// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PersonalExecutionSetup } from "./PersonalExecutionSetup";
import { personalFixture, PERSONAL_ACTOR, PERSONAL_WORKSPACE } from "../personal-execution-fixtures";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function fixture() {
  const state = personalFixture(); let grants = [state.grant];
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input); calls.push({ path, init });
    if (path.endsWith("/computers")) return Response.json({ computers: [state.computer] });
    if (path.endsWith("/grants") && init?.method === "POST") { grants = [state.grant]; return Response.json(state.grant, { status: 201 }); }
    if (path.endsWith("/grants")) return Response.json({ grants });
    if (path.endsWith("/pairing-token")) return Response.json({ token: "fixture-only-code", expiresAt: Date.now() + 600_000, connectCommand: "fixture personal connect" });
    if (init?.method === "DELETE") { grants = [{ ...state.grant, status: "revoked", version: 2 }]; return Response.json({ revoked: true, version: 2 }); }
    throw new Error(`Unexpected fixture route ${path}`);
  });
  vi.stubGlobal("fetch", fetcher);
  return { state, calls, fetcher, setGrants: (next: typeof grants) => { grants = next; } };
}
function props() { return { workspaceId: PERSONAL_WORKSPACE, actorId: PERSONAL_ACTOR, onSelectionChange: vi.fn() }; }
async function openSetup() { await screen.findByLabelText("Personal account grant for this room task"); fireEvent.click(screen.getByText("Pair a computer or create an explicit grant")); }
function fillGrant() {
  const account = screen.getByLabelText("Locally observed account") as HTMLSelectElement;
  fireEvent.change(account, { target: { value: account.options[1]!.value } });
  fireEvent.change(screen.getByLabelText("Exact model ID"), { target: { value: "openai/fixture-model" } });
  fireEvent.change(screen.getByLabelText("Public GitHub repository"), { target: { value: "https://github.com/owner/public-repo" } });
}

describe("explicit personal setup", () => {
  it("does not pair, create or select any account automatically", async () => {
    const f = fixture(), p = props(); render(<PersonalExecutionSetup {...p} />); await openSetup();
    expect(screen.getByLabelText("Personal account grant for this room task")).toHaveProperty("value", "");
    expect(screen.getByLabelText("Locally observed account")).toHaveProperty("value", "");
    expect(screen.getByRole("button", { name: "Generate my personal pairing code" })).toHaveProperty("disabled", true);
    expect(f.calls.every((call) => call.init?.method === "GET")).toBe(true);
    expect(p.onSelectionChange).not.toHaveBeenCalled();
  });
  it("requires exact model and both consents, then creates without selecting or starting work", async () => {
    const f = fixture(), p = props(); render(<PersonalExecutionSetup {...p} />); await openSetup(); fillGrant();
    const create = screen.getByRole("button", { name: "Create personal execution grant" });
    expect(create).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByLabelText(/I allow this selected account/)); expect(create).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByLabelText(/I understand this deployment/)); expect(create).toHaveProperty("disabled", false);
    fireEvent.change(screen.getByLabelText("Exact model ID"), { target: { value: "anthropic/wrong-lane" } }); expect(create).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByLabelText("Exact model ID"), { target: { value: "openai/fixture-model" } }); fireEvent.click(create);
    await screen.findByText(/Grant created. Select it explicitly/);
    const write = f.calls.find((call) => call.init?.method === "POST")!;
    expect(JSON.parse(String(write.init?.body))).toMatchObject({ machineId: "machine-personal", machineRevision: 3, harness: "codex",
      codingModel: "openai/fixture-model", consent: true, hostingConsent: true });
    expect(p.onSelectionChange).not.toHaveBeenCalled();
    expect(f.calls.every((call) => call.path.startsWith("/api/personal-execution/"))).toBe(true);
  });
  it("pairs only after explicit local CLI and nonsecret fingerprint selection, and hides the code", async () => {
    const f = fixture(); render(<PersonalExecutionSetup {...props()} />); await openSetup();
    fireEvent.change(screen.getByLabelText("Native CLI to pair"), { target: { value: "codex" } });
    fireEvent.change(screen.getByLabelText("Locally inspected account fingerprint"), { target: { value: "a".repeat(64) } });
    fireEvent.click(screen.getByRole("button", { name: "Generate my personal pairing code" }));
    await screen.findByText("fixture personal connect");
    const write = f.calls.find((call) => call.path.endsWith("pairing-token"))!;
    expect(JSON.parse(String(write.init?.body))).toEqual({ harness: "codex", accountFingerprint: "a".repeat(64) });
    fireEvent.click(screen.getByRole("button", { name: "Hide pairing code" })); expect(screen.queryByText("fixture personal connect")).toBeNull();
    expect(localStorage.length).toBe(0);
  });
  it("selects only an explicit current grant and clears revoked cached authority without fallback", async () => {
    const f = fixture(), p = props(); const view = render(<PersonalExecutionSetup {...p} />); await openSetup();
    fireEvent.change(screen.getByLabelText("Personal account grant for this room task"), { target: { value: f.state.grant.snapshot.grantId } });
    expect(p.onSelectionChange).toHaveBeenLastCalledWith(f.state.grant);
    view.rerender(<PersonalExecutionSetup {...p} selected={f.state.grant} />);
    f.setGrants([{ ...f.state.grant, status: "revoked", version: 2 }]);
    fireEvent.click(screen.getByRole("button", { name: "Reload personal setup" }));
    await waitFor(() => expect(p.onSelectionChange).toHaveBeenLastCalledWith(null));
    const option = screen.getByRole("option", { name: /fixture-model.*unavailable/ }); expect(option).toHaveProperty("disabled", true);
    expect(f.calls.some((call) => call.path.includes("/api/runs") || call.path.includes("/api/providers"))).toBe(false);
  });
  it("removes private setup after denied membership and never exposes raw server errors", async () => {
    fixture(); vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "fixture credential must never render" }, { status: 403 })));
    render(<PersonalExecutionSetup {...props()} />);
    await screen.findByRole("alert"); expect(screen.queryByText(/fixture credential/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Generate my personal pairing code" })).toBeNull();
  });
  it("does not show an offline account as an available grant", async () => {
    const f = fixture(); f.state.computer.status = "offline"; render(<PersonalExecutionSetup {...props()} />); await openSetup();
    expect(screen.getByRole("option", { name: /fixture-model.*unavailable/ })).toHaveProperty("disabled", true);
    expect((screen.getByLabelText("Locally observed account") as HTMLSelectElement).options).toHaveLength(1);
  });
  it("discards a late pairing response after a workspace switch", async () => {
    const f = fixture(); let resolve!: (response: Response) => void;
    const base = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (input, init) => String(input).endsWith("/pairing-token")
      ? new Promise<Response>((settle) => { resolve = settle; }) : base(input, init));
    const view = render(<PersonalExecutionSetup {...props()} />); await openSetup();
    fireEvent.change(screen.getByLabelText("Native CLI to pair"), { target: { value: "codex" } });
    fireEvent.change(screen.getByLabelText("Locally inspected account fingerprint"), { target: { value: "a".repeat(64) } });
    fireEvent.click(screen.getByRole("button", { name: "Generate my personal pairing code" }));
    await waitFor(() => expect(resolve).toBeTypeOf("function"));
    view.rerender(<PersonalExecutionSetup {...props()} workspaceId={"ws_" + "b".repeat(24)} />);
    await act(async () => { resolve(Response.json({ token: "old-scope", expiresAt: Date.now() + 60_000, connectCommand: "private old pairing" })); });
    expect(screen.queryByText("private old pairing")).toBeNull();
    expect(screen.getByLabelText("Locally inspected account fingerprint")).toHaveProperty("value", "");
  });
  it("discards a late grant response and consent after an actor switch", async () => {
    const f = fixture(), p = props(); let resolve!: (response: Response) => void;
    const base = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (input, init) => String(input).endsWith("/grants") && init?.method === "POST"
      ? new Promise<Response>((settle) => { resolve = settle; }) : base(input, init));
    const view = render(<PersonalExecutionSetup {...p} />); await openSetup(); fillGrant();
    fireEvent.click(screen.getByLabelText(/I allow this selected account/)); fireEvent.click(screen.getByLabelText(/I understand this deployment/));
    fireEvent.click(screen.getByRole("button", { name: "Create personal execution grant" }));
    await waitFor(() => expect(resolve).toBeTypeOf("function"));
    const next = vi.fn(); view.rerender(<PersonalExecutionSetup workspaceId={PERSONAL_WORKSPACE} actorId="other@example.test" onSelectionChange={next} />);
    await act(async () => { resolve(Response.json(f.state.grant, { status: 201 })); });
    expect(screen.queryByText(/Grant created. Select it explicitly/)).toBeNull();
    expect(screen.getByLabelText("Exact model ID")).toHaveProperty("value", ""); expect(next).not.toHaveBeenCalled();
  });
  it("ignores delayed initial owner reads after actor change without selecting old authority", async () => {
    const state = personalFixture(), delayed: Array<(response: Response) => void> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/harness")) return Response.json({ runs: [] });
      if (delayed.length < 2) return new Promise<Response>((resolve) => { delayed.push(resolve); });
      return Response.json(path.endsWith("/computers") ? { computers: [] } : { grants: [] });
    }));
    const first = props(), second = vi.fn();
    const view = render(<PersonalExecutionSetup {...first} />); await waitFor(() => expect(delayed).toHaveLength(2));
    view.rerender(<PersonalExecutionSetup workspaceId={PERSONAL_WORKSPACE} actorId="other@example.test" onSelectionChange={second} />);
    await act(async () => { delayed[0]!(Response.json({ computers: [state.computer] })); delayed[1]!(Response.json({ grants: [state.grant] })); });
    expect(screen.queryByText(/machine-personal/)).toBeNull();
    expect(screen.getByLabelText("Personal account grant for this room task")).toHaveProperty("value", ""); expect(second).not.toHaveBeenCalled();
  });
});
