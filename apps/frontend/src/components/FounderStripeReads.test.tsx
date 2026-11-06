// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FounderStripeReads } from "./FounderStripeReads";
import { StrictMode } from "react";
import { STRIPE_ACTOR, STRIPE_WORKSPACE, stripeGrant, stripeScope } from "../founder-stripe-fixtures";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("private Stripe read review", () => {
  it("starts with no key and requires explicit read-only attestation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...stripeScope, available: true, grants: [] })));
    render(<FounderStripeReads workspaceId={STRIPE_WORKSPACE} actorId={STRIPE_ACTOR} onClose={() => {}} />);
    await screen.findByText("Prepare a private Stripe draft");
    const key = screen.getByLabelText("Restricted read-only key") as HTMLInputElement;
    expect(key.type).toBe("password"); expect(key.value).toBe("");
    expect(screen.getByRole("button", { name: "Prepare private draft" })).toHaveProperty("disabled", true);
  });
  it("requires both exact reviews to enable a verified grant", async () => {
    const grant = { ...stripeGrant(), state: "verified" as const };
    const send = vi.fn(async (url: RequestInfo | URL) => String(url).endsWith(grant.id) ? Response.json({ ...stripeScope, grant, receipts: [] }) : Response.json({ ...stripeScope, available: true, grants: [grant] })); vi.stubGlobal("fetch", send);
    render(<FounderStripeReads workspaceId={STRIPE_WORKSPACE} actorId={STRIPE_ACTOR} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Review grant" }));
    const enable = await screen.findByRole("button", { name: "Enable exact Stripe reads" }); expect(enable).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByLabelText(/I reviewed this exact account/)); expect(enable).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByLabelText(/I authorize the exact daily reads/)); expect(enable).toHaveProperty("disabled", false);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("shows disabled service without provider details or mutation", async () => {
    const send = vi.fn(async () => new Response("private key detail", { status: 503 })); vi.stubGlobal("fetch", send);
    render(<FounderStripeReads workspaceId={STRIPE_WORKSPACE} actorId={STRIPE_ACTOR} onClose={() => {}} />);
    await screen.findByText(/unavailable or disabled/); expect(screen.queryByText("private key detail")).toBeNull(); expect(send).toHaveBeenCalledTimes(1);
  });
  it("keeps existing grants revocable when the feature is disabled", async () => {
    const grant = stripeGrant(); const send = vi.fn(async (url: RequestInfo | URL) => String(url).endsWith(grant.id) ? Response.json({ ...stripeScope, grant, receipts: [] }) : Response.json({ ...stripeScope, available: false, grants: [grant] })); vi.stubGlobal("fetch", send);
    render(<FounderStripeReads workspaceId={STRIPE_WORKSPACE} actorId={STRIPE_ACTOR} onClose={() => {}} />); await screen.findByText(/disabled or unavailable/);
    expect(screen.queryByText("Prepare a private Stripe draft")).toBeNull(); fireEvent.click(screen.getByRole("button", { name: "Review grant" }));
    expect(await screen.findByRole("button", { name: "Revoke Stripe grant" })).not.toHaveProperty("disabled", true); expect(screen.queryByRole("button", { name: "Verify exact Stripe account" })).toBeNull();
  });
  it("clears the password immediately and never retries an uncertain draft", async () => {
    const send = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === "POST" ? new Response("sensitive", { status: 503 }) : Response.json({ ...stripeScope, available: true, grants: [] })); vi.stubGlobal("fetch", send);
    render(<FounderStripeReads workspaceId={STRIPE_WORKSPACE} actorId={STRIPE_ACTOR} onClose={() => {}} />); await screen.findByText("Prepare a private Stripe draft");
    fireEvent.change(screen.getByLabelText("Stripe account ID"), { target: { value: "acct_fixture" } }); fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "test" } });
    const key = screen.getByLabelText("Restricted read-only key") as HTMLInputElement; fireEvent.change(key, { target: { value: `rk_test_${"x".repeat(24)}` } });
    fireEvent.change(screen.getByLabelText("Selected resource"), { target: { value: "invoices" } });
    fireEvent.change(screen.getByLabelText("Created from (local time)"), { target: { value: "2020-01-01T00:00" } }); fireEvent.change(screen.getByLabelText("Created before (local time)"), { target: { value: "2021-01-01T00:00" } });
    fireEvent.change(screen.getByLabelText("Grant expiry (local time)"), { target: { value: new Date(Date.now() + 86400000).toISOString().slice(0, 16) } });
    fireEvent.change(screen.getByLabelText("Maximum records per capture"), { target: { value: "10" } }); fireEvent.change(screen.getByLabelText("Maximum provider calls, including verification"), { target: { value: "3" } });
    fireEvent.click(screen.getByLabelText(/I confirm this is a restricted key/)); fireEvent.click(screen.getByRole("button", { name: "Prepare private draft" }));
    expect(key.value).toBe(""); await screen.findByRole("alert"); expect(send).toHaveBeenCalledTimes(2); expect(screen.queryByText("sensitive")).toBeNull();
  });
  it("discards an old account response after a native scope switch", async () => {
    let release!: (value: Response) => void; const old = new Promise<Response>((resolve) => { release = resolve; });
    const nextActor = "second@example.test"; let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => ++calls === 1 ? old : Response.json({ ...stripeScope, actorId: nextActor, available: true, grants: [] })));
    const view = render(<FounderStripeReads workspaceId={STRIPE_WORKSPACE} actorId={STRIPE_ACTOR} onClose={() => {}} />);
    view.rerender(<FounderStripeReads workspaceId={STRIPE_WORKSPACE} actorId={nextActor} onClose={() => {}} />); await screen.findByText("Prepare a private Stripe draft");
    await act(async () => { release(Response.json({ ...stripeScope, available: true, grants: [stripeGrant()] })); }); expect(screen.queryByText(/acct_fixture/)).toBeNull();
  });
  it("does not let a stale Strict Mode request release a newer request's busy state", async () => {
    let releaseOld!: (value: Response) => void, releaseNew!: (value: Response) => void;
    const old = new Promise<Response>((resolve) => { releaseOld = resolve; }), next = new Promise<Response>((resolve) => { releaseNew = resolve; });
    let calls = 0; vi.stubGlobal("fetch", vi.fn(async () => ++calls === 1 ? old : next));
    render(<StrictMode><FounderStripeReads workspaceId={STRIPE_WORKSPACE} actorId={STRIPE_ACTOR} onClose={() => {}} /></StrictMode>);
    await act(async () => { releaseOld(Response.json({ ...stripeScope, available: true, grants: [] })); });
    expect(screen.getByRole("button", { name: "Refresh Stripe access" })).toHaveProperty("disabled", true);
    await act(async () => { releaseNew(Response.json({ ...stripeScope, available: true, grants: [] })); });
    await screen.findByText("Prepare a private Stripe draft"); expect(screen.getByRole("button", { name: "Refresh Stripe access" })).toHaveProperty("disabled", false);
  });
});
