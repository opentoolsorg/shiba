// @vitest-environment happy-dom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FounderMetaReads } from "./FounderMetaReads";
import { META_ACTOR, META_WORKSPACE, metaGrant, metaScope } from "../founder-meta-fixtures";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("private Meta reviewed reads", () => {
  it("survives Strict Mode setup replay and needs an explicit token attestation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...metaScope, available: true, grants: [] })));
    render(<StrictMode><FounderMetaReads workspaceId={META_WORKSPACE} actorId={META_ACTOR} onClose={() => {}} /></StrictMode>);
    await screen.findByText("Prepare a private Meta draft"); expect(screen.getByRole("button", { name: "Refresh Meta access" })).toHaveProperty("disabled", false);
    expect((screen.getByLabelText("Meta access token") as HTMLInputElement).type).toBe("password"); expect(screen.getByRole("button", { name: "Prepare private draft" })).toHaveProperty("disabled", true);
  });
  it("clears a detached token input on close", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...metaScope, available: true, grants: [] })));
    const view = render(<FounderMetaReads workspaceId={META_WORKSPACE} actorId={META_ACTOR} onClose={() => {}} />); await screen.findByText("Prepare a private Meta draft");
    const input = screen.getByLabelText("Meta access token") as HTMLInputElement; fireEvent.change(input, { target: { value: "fixture-token-never-real" } });
    fireEvent.click(screen.getByLabelText(/I attest that I created/)); expect(input.value).toBe("fixture-token-never-real"); view.unmount(); expect(input.value).toBe("");
  });
  it("requires separate exact verified account and quota reviews before enable", async () => {
    const g = { ...metaGrant(), state: "verified" as const, currency: "USD", timezoneName: "UTC", usedCalls: 1 };
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => String(url).endsWith(g.id) ? Response.json({ ...metaScope, grant: g, receipts: [] }) : Response.json({ ...metaScope, available: true, grants: [g] })));
    render(<FounderMetaReads workspaceId={META_WORKSPACE} actorId={META_ACTOR} onClose={() => {}} />); fireEvent.click(await screen.findByRole("button", { name: "Review grant" }));
    const enable = await screen.findByRole("button", { name: "Enable exact Meta reads" }); expect(enable).toHaveProperty("disabled", true); fireEvent.click(screen.getByLabelText(/I reviewed this exact ad account/)); expect(enable).toHaveProperty("disabled", true); fireEvent.click(screen.getByLabelText(/I authorize the exact daily reads/)); expect(enable).toHaveProperty("disabled", false);
  });
  it("discards an old account response after switching actor", async () => {
    let release!: (value: Response) => void; const held = new Promise<Response>((resolve) => { release = resolve; }); let n = 0; const next = "other@example.test";
    vi.stubGlobal("fetch", vi.fn(async () => ++n === 1 ? held : Response.json({ ...metaScope, actorId: next, available: true, grants: [] })));
    const view = render(<FounderMetaReads workspaceId={META_WORKSPACE} actorId={META_ACTOR} onClose={() => {}} />); view.rerender(<FounderMetaReads workspaceId={META_WORKSPACE} actorId={next} onClose={() => {}} />); await screen.findByText("Prepare a private Meta draft");
    await act(async () => { release(Response.json({ ...metaScope, available: true, grants: [metaGrant()] })); }); expect(screen.queryByText(/123456789/)).toBeNull();
  });
  it("requires refresh if a verification finishes after the tab is hidden", async () => {
    const grant = metaGrant(); let finish!: (value: Response) => void; const held = new Promise<Response>((resolve) => { finish = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => init?.method === "POST" ? held : String(path).endsWith(grant.id) ? Response.json({ ...metaScope, grant, receipts: [] }) : Response.json({ ...metaScope, available: true, grants: [grant] })));
    render(<FounderMetaReads workspaceId={META_WORKSPACE} actorId={META_ACTOR} onClose={() => {}} />); fireEvent.click(await screen.findByRole("button", { name: "Review grant" })); fireEvent.click(await screen.findByRole("button", { name: "Verify exact Meta account" }));
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden"); fireEvent(document, new Event("visibilitychange"));
    await act(async () => { finish(Response.json({ ...metaScope, grant: { ...grant, state: "verified", currency: "USD", timezoneName: "UTC", usedCalls: 1, digest: "a".repeat(64) } })); });
    expect(screen.getByText(/Refresh current state before another action/)).toBeTruthy(); expect(screen.queryByRole("button", { name: "Enable exact Meta reads" })).toBeNull(); visibility.mockRestore();
  });
});
