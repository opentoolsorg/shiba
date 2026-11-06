// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BootstrapVerificationCallback, BootstrapVerificationPanel } from "./BootstrapVerificationPanel";

const status = { kind: "bootstrap", email: "owner@example.test", emailVerified: false, available: true, statusSnapshot: "a".repeat(64) };
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJmaXh0dXJlIjp0cnVlfQ.c2lnbmF0dXJl";
const json = (value: unknown, code = 200) => new Response(JSON.stringify(value), { status: code, headers: { "content-type": "application/json" } });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); window.history.replaceState(null, "", "/app/"); });
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve }; }

describe("explicit bootstrap verification", () => {
  it("only reads status on mount and sends the current opaque snapshot after a deliberate click", async () => {
    const fetcher = vi.fn(async (_url: string, options: RequestInit) => json(options.method === "GET" ? status : { sent: true })); vi.stubGlobal("fetch", fetcher);
    render(<BootstrapVerificationPanel identityKey="owner:workspace" />);
    expect(await screen.findByText(/owner@example.test/)).toBeTruthy(); expect(fetcher).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Send verification email" }));
    expect(await screen.findByText(/Check your email/)).toBeTruthy();
    expect(fetcher.mock.calls[1]).toEqual(["/api/auth/bootstrap-verification", expect.objectContaining({ method: "POST", body: JSON.stringify({ expectedSnapshot: status.statusSnapshot }), credentials: "same-origin", redirect: "error", referrerPolicy: "no-referrer" })]);
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain("emailVerified");
  });
  it("shows configured-sender prerequisites and keeps send unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ ...status, available: false, reason: "Configure SEND_EMAIL and a verified sender." })));
    render(<BootstrapVerificationPanel identityKey="owner" />);
    expect(await screen.findByText(/Configure SEND_EMAIL/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Send verification email" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("ignores late status from a replaced identity scope", async () => {
    const old = deferred<Response>(); const fetcher = vi.fn().mockImplementationOnce(() => old.promise).mockResolvedValue(json({ ...status, email: "new@example.test", statusSnapshot: "b".repeat(64) })); vi.stubGlobal("fetch", fetcher);
    const view = render(<BootstrapVerificationPanel identityKey="old" />);
    view.rerender(<BootstrapVerificationPanel identityKey="new" />);
    expect(await screen.findByText(/new@example.test/)).toBeTruthy();
    await act(async () => { old.resolve(json(status)); });
    expect(screen.queryByText(/owner@example.test/)).toBeNull();
  });
  it("clears cached identity and send capability when a refresh loses account authority", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json(status)).mockResolvedValueOnce(json({ error: "revoked" }, 401)); vi.stubGlobal("fetch", fetcher);
    render(<BootstrapVerificationPanel identityKey="owner" />);
    expect(await screen.findByText(/owner@example.test/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh verification status" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByText(/owner@example.test/)).toBeNull(); expect(screen.queryByRole("button", { name: "Send verification email" })).toBeNull();
    expect(fetcher.mock.calls.every(call => (call[1] as RequestInit).method === "GET")).toBe(true);
  });
  it("clears the fragment in StrictMode without sending or logging the proof, and confirms only on click", async () => {
    window.history.replaceState(null, "", `/app/?verify=bootstrap#bootstrapVerification=${JWT}`);
    const fetcher = vi.fn(async (_url: string, _options: RequestInit) => json({ verified: true })); vi.stubGlobal("fetch", fetcher);
    const view = render(<StrictMode><BootstrapVerificationCallback /></StrictMode>);
    expect(window.location.hash).toBe(""); expect(fetcher).not.toHaveBeenCalled(); expect(view.container.textContent).not.toContain(JWT);
    fireEvent.click(screen.getByRole("button", { name: "Confirm email" }));
    expect(await screen.findByText(/Email verified/)).toBeTruthy();
    expect(fetcher).toHaveBeenCalledTimes(1); expect(fetcher.mock.calls[0]).toEqual(["/api/auth/bootstrap-verification/confirm", expect.objectContaining({ method: "POST", body: JSON.stringify({ token: JWT }), redirect: "error" })]);
    expect(window.location.search).toBe("?verify=bootstrap");
  });
  it("never confirms from a missing/malformed link and does not reflect its contents", () => {
    window.history.replaceState(null, "", "/app/?verify=bootstrap#bootstrapVerification=private-malformed-value");
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const view = render(<BootstrapVerificationCallback />);
    expect(window.location.hash).toBe(""); expect(view.container.textContent).not.toContain("private-malformed-value");
    expect(screen.queryByRole("button", { name: "Confirm email" })).toBeNull(); expect(fetcher).not.toHaveBeenCalled();
  });
  it("fails closed on replay/expired proof and never retries automatically", async () => {
    window.history.replaceState(null, "", `/app/?verify=bootstrap#bootstrapVerification=${JWT}`);
    const fetcher = vi.fn(async () => json({ error: JWT }, 403)); vi.stubGlobal("fetch", fetcher);
    const view = render(<BootstrapVerificationCallback />); fireEvent.click(screen.getByRole("button", { name: "Confirm email" }));
    expect(await screen.findByRole("alert")).toBeTruthy(); expect(view.container.textContent).not.toContain(JWT);
    expect(fetcher).toHaveBeenCalledTimes(1); expect(screen.queryByRole("button", { name: "Confirm email" })).toBeNull();
  });
  it("settles a stalled verification request without retrying", async () => {
    vi.useFakeTimers(); window.history.replaceState(null, "", `/app/?verify=bootstrap#bootstrapVerification=${JWT}`);
    const fetcher = vi.fn((_url: string, _options: RequestInit) => new Promise<Response>(() => {})); vi.stubGlobal("fetch", fetcher);
    render(<BootstrapVerificationCallback />); fireEvent.click(screen.getByRole("button", { name: "Confirm email" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(15_001); });
    expect(screen.getByRole("alert")).toBeTruthy(); expect(fetcher).toHaveBeenCalledTimes(1);
    expect((fetcher.mock.calls[0]?.[1] as RequestInit).signal?.aborted).toBe(true);
  });
});
