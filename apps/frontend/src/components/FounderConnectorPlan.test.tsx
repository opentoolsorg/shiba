// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FounderConnectorPlan as Plan } from "@shiba/shared";
import { FounderConnectorPlan } from "./FounderConnectorPlan";
import { FOUNDER_BASE, FOUNDER_LIBRARY, FOUNDER_WORKSPACE, founderOptions, founderPlan, enabledFounderPlan, founderOccurrence, founderState, withFounderApproval } from "../founder-connector-fixtures";

const props = { workspaceId: FOUNDER_WORKSPACE, libraryId: FOUNDER_LIBRARY, name: "Revenue", timezone: "UTC", onClose: vi.fn() };
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("FounderConnectorPlan", () => {
  it("requires exact account/action selection and frozen review before enabling storage-only occurrences", async () => {
    let plan: Plan | null = null;
    const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/options")) return Response.json(founderOptions());
      if (path.includes("/actions?")) return Response.json({ ...founderState(), connectionId: "account-one", employeeId: "employee-one", employeeVersion: 2, actions: [{ id: "stripe.list-subscriptions", service: "stripe", name: "List subscriptions", inputSchema: founderPlan().contract.inputSchema }] });
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>; writes.push({ path, body });
        plan = path.endsWith("/enable") ? { ...plan!, version: 2, state: "enabled", canEnable: false, canPause: true }
          : { ...founderPlan(), contract: { ...founderPlan().contract, ...body } } as Plan;
      }
      return Response.json(founderState(plan));
    });
    vi.stubGlobal("fetch", fetcher);
    render(<FounderConnectorPlan {...props} />);
    const prepare = await screen.findByRole("button", { name: "Prepare exact action plan" });
    expect((prepare as HTMLButtonElement).disabled).toBe(true);
    expect(writes).toEqual([]);
    fireEvent.change(screen.getByRole("combobox", { name: "Employee version" }), { target: { value: "employee-one" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Workspace app account" }), { target: { value: "account-one" } });
    fireEvent.click(screen.getByRole("button", { name: "Find exact app actions" }));
    await screen.findByRole("option", { name: "List subscriptions · stripe.list-subscriptions" });
    fireEvent.change(screen.getByRole("combobox", { name: "Action" }), { target: { value: "stripe.list-subscriptions" } });
    fireEvent.change(screen.getByLabelText("Fixed action arguments"), { target: { value: '{"limit":10}' } });
    fireEvent.click(prepare);
    await screen.findByText(`Plan digest: ${"a".repeat(64)}`);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ path: FOUNDER_BASE, body: { employeeId: "employee-one", employeeVersion: 2, skillVersion: 3, connectionId: "account-one", connectionVersion: 4, actionId: "stripe.list-subscriptions", arguments: { limit: 10 }, expectedVersion: 0 } });
    const enable = screen.getByRole("button", { name: "Enable app action reviews" });
    expect((enable as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed this exact account/ }));
    fireEvent.click(enable); fireEvent.click(enable);
    await screen.findByText("State: enabled · revision 2");
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual({ path: `${FOUNDER_BASE}/enable`, body: { expectedVersion: 1, digest: "a".repeat(64), reviewed: true } });
    expect(fetcher.mock.calls.every(([path]) => String(path).startsWith(FOUNDER_BASE))).toBe(true);
    expect(screen.getByText(/It calls no model, reads no app data/)).toBeTruthy();
  });

  it("requires explicit occurrence preparation, manager decision and one requester execution before a private receipt", async () => {
    const plan = enabledFounderPlan(); let item = founderOccurrence(plan);
    const writes: string[] = [], effects = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/options")) return Response.json(founderOptions());
      if (init?.method === "POST") {
        writes.push(path);
        if (path.endsWith("/prepare")) item = withFounderApproval(item);
        if (path.endsWith("/decision")) item = withFounderApproval(item, "approved");
        if (path.endsWith("/execute")) { effects(); item = withFounderApproval(item, "completed"); }
      }
      return Response.json(founderState(plan, [item]));
    }));
    render(<FounderConnectorPlan {...props} />);
    const prepare = await screen.findByRole("button", { name: "Request review for this occurrence" });
    expect(effects).not.toHaveBeenCalled(); expect(writes).toEqual([]);
    fireEvent.click(prepare); fireEvent.click(prepare);
    const approve = await screen.findByRole("button", { name: "Approve exact occurrence action" });
    expect(effects).not.toHaveBeenCalled(); expect(writes).toHaveLength(1);
    fireEvent.click(approve);
    const execute = await screen.findByRole("button", { name: "Execute approved occurrence once" });
    expect(effects).not.toHaveBeenCalled(); expect(writes).toHaveLength(2);
    fireEvent.click(execute); fireEvent.click(execute);
    await screen.findByText(/owner-only-output/);
    expect(effects).toHaveBeenCalledOnce();
    expect(writes).toEqual([`${FOUNDER_BASE}/occurrences/occurrence-one/prepare`, `${FOUNDER_BASE}/occurrences/occurrence-one/decision`, `${FOUNDER_BASE}/occurrences/occurrence-one/execute`]);
    expect(screen.queryByRole("button", { name: "Execute approved occurrence once" })).toBeNull();
  });

  it("does not infer execution or configuration authority from a manager-looking workspace", async () => {
    const plan = enabledFounderPlan(), item = withFounderApproval(founderOccurrence(plan), "approved");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/options")
      ? Response.json({ ...founderOptions(), canConfigure: false }) : Response.json({ ...founderState({ ...plan, canPause: false, canRevoke: false }, [{ ...item, canExecute: false, approval: { ...item.approval!, canExecute: false } }]), canConfigure: false })));
    render(<FounderConnectorPlan {...props} />);
    await screen.findByText(/A verified native workspace manager/);
    expect((screen.getByRole("button", { name: "Prepare exact action plan" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Execute approved occurrence once" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Pause app action reviews" })).toBeNull();
  });

  it("keeps an uncertain execution blocked after refresh without repeating a vendor action", async () => {
    const plan = enabledFounderPlan(), item = withFounderApproval(founderOccurrence(plan), "approved");
    const writes: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/options")) return Response.json(founderOptions());
      if (init?.method === "POST") { writes.push(String(input)); throw new TypeError("Connection lost after request"); }
      return Response.json(founderState(plan, [item]));
    }));
    render(<FounderConnectorPlan {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Execute approved occurrence once" }));
    await screen.findByRole("alert");
    expect(screen.queryByText(`Plan digest: ${plan.digest}`)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Refresh app action plan" }));
    const execute = await screen.findByRole("button", { name: "Execute approved occurrence once" });
    expect((execute as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(execute);
    expect(writes).toHaveLength(1);
    expect(screen.getByText(/Execution response unconfirmed/)).toBeTruthy();
  });

  it("aborts A and discards late private output after an unkeyed workspace switch to B", async () => {
    const foreign = `ws_${"b".repeat(24)}`, plan = enabledFounderPlan(), item = withFounderApproval(founderOccurrence(plan), "approved");
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { finish = resolve; });
    const calls: Array<{ workspace: string | null; signal?: AbortSignal | null }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const workspace = new Headers(init?.headers).get("X-Shiba-Workspace"); calls.push({ workspace, signal: init?.signal });
      if (init?.method === "POST") return pending;
      if (String(input).endsWith("/options")) return Response.json({ ...founderOptions(), workspaceId: workspace, connections: founderOptions().connections.map((account) => ({ ...account, workspaceId: workspace })) });
      return Response.json(workspace === foreign ? { ...founderState(), workspaceId: foreign } : founderState(plan, [item]));
    }));
    const { rerender } = render(<FounderConnectorPlan {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Execute approved occurrence once" }));
    rerender(<FounderConnectorPlan {...props} workspaceId={foreign} />);
    await screen.findByRole("combobox", { name: "Employee version" });
    await act(async () => finish(Response.json(founderState(plan, [withFounderApproval(item, "completed")]))));
    expect(screen.queryByText(/owner-only-output/)).toBeNull();
    expect(screen.queryByText(`Plan digest: ${plan.digest}`)).toBeNull();
    expect(calls.filter((call) => call.workspace === FOUNDER_WORKSPACE).every((call) => call.signal?.aborted)).toBe(true);
  });

  it("removes protected plan arguments and receipts after access is revoked", async () => {
    let revoked = false;
    const plan = enabledFounderPlan(), item = withFounderApproval(founderOccurrence(plan), "completed");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => revoked ? Response.json({ error: "source_revoked" }, { status: 403 })
      : String(input).endsWith("/options") ? Response.json(founderOptions()) : Response.json(founderState(plan, [item]))));
    render(<FounderConnectorPlan {...props} />);
    await screen.findByText(/owner-only-output/);
    revoked = true; fireEvent(window, new Event("focus"));
    await screen.findByRole("alert");
    expect(screen.queryByText(/owner-only-output/)).toBeNull();
    expect(screen.queryByText(`Plan digest: ${plan.digest}`)).toBeNull();
  });

  it("polls current permissions while idle and clears revoked output without a mutation", async () => {
    vi.useFakeTimers();
    let revoked = false;
    const plan = enabledFounderPlan(), item = withFounderApproval(founderOccurrence(plan), "completed");
    const fetcher = vi.fn(async (input: RequestInfo | URL) => revoked ? Response.json({ error: "revoked" }, { status: 403 })
      : String(input).endsWith("/options") ? Response.json(founderOptions()) : Response.json(founderState(plan, [item])));
    vi.stubGlobal("fetch", fetcher);
    render(<FounderConnectorPlan {...props} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText(/owner-only-output/)).toBeTruthy();
    revoked = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(20_001); });
    expect(screen.queryByText(/owner-only-output/)).toBeNull();
    expect(screen.queryByText(`Plan digest: ${plan.digest}`)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls.every((call) => (call as unknown as [string, RequestInit])[1].method === "GET")).toBe(true);
  });

  it.each(["plan", "approval"])("hides protected content at the local %s lease boundary without waiting for a poll", async (lease) => {
    vi.useFakeTimers();
    const plan = enabledFounderPlan(), item = withFounderApproval(founderOccurrence(plan), "completed");
    if (lease === "plan") plan.contract.expiresAt = Date.now() + 100;
    else item.approval!.expiresAt = Date.now() + 100;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/options") ? Response.json(founderOptions()) : Response.json(founderState(plan, [item])));
    vi.stubGlobal("fetch", fetcher);
    render(<FounderConnectorPlan {...props} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText(/owner-only-output/)).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(101); });
    expect(screen.queryByText(/owner-only-output/)).toBeNull();
    if (lease === "plan") expect(screen.queryByText(`Plan digest: ${plan.digest}`)).toBeNull();
    else expect(screen.getByText(/· expired/)).toBeTruthy();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Execute approved occurrence once" })).toBeNull();
  });

  it("stays unavailable without an active skill or authorized account and never starts OAuth", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return Response.json(String(input).endsWith("/options") ? { ...founderOptions(), skill: null, connections: [] } : founderState());
    }));
    render(<FounderConnectorPlan {...props} />);
    await screen.findByText(/Install, review and activate this founder skill/);
    expect((screen.getByRole("button", { name: "Prepare exact action plan" }) as HTMLButtonElement).disabled).toBe(true);
    expect(calls.sort()).toEqual([FOUNDER_BASE, `${FOUNDER_BASE}/options`]);
    expect(screen.getByText(/A catalog entry is not an account connection/)).toBeTruthy();
  });
});
