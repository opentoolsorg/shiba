// @vitest-environment happy-dom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FounderHubSpotReads } from "./FounderHubSpotReads";
import { HUBSPOT_ACTOR, HUBSPOT_WORKSPACE, hubspotGrant, hubspotScope } from "../founder-hubspot-fixtures";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("private HubSpot reviewed reads", () => {
  it("submits the exact portal and properties only after token attestation without enabling reads", async () => {
    const expiresAt = Math.floor((Date.now() + 3600000) / 60000) * 60000;
    const grant = { ...hubspotGrant(), expiresAt };
    const send = vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => init?.method === "POST"
      ? Response.json({ ...hubspotScope, grant: { id: grant.id, digest: grant.digest, fingerprint: grant.fingerprint, state: "draft" } })
      : String(path).endsWith(grant.id) ? Response.json({ ...hubspotScope, grant, receipts: [] }) : Response.json({ ...hubspotScope, available: true, grants: [] }));
    vi.stubGlobal("fetch", send);
    render(<FounderHubSpotReads workspaceId={HUBSPOT_WORKSPACE} actorId={HUBSPOT_ACTOR} onClose={() => {}} />);
    await screen.findByText("Prepare a private HubSpot draft");
    fireEvent.change(screen.getByLabelText("Numeric HubSpot portal ID"), { target: { value: grant.accountId } });
    const token = screen.getByLabelText("HubSpot static/private-app token") as HTMLInputElement;
    fireEvent.change(token, { target: { value: "fixture-not-a-real-token" } });
    fireEvent.change(screen.getByLabelText("Deal IDs (comma or space separated)"), { target: { value: "1, 2" } });
    fireEvent.change(screen.getByLabelText("Invoice ID internal property"), { target: { value: "invoice_id" } });
    fireEvent.change(screen.getByLabelText("Paid amount internal property"), { target: { value: "paid_amount" } });
    fireEvent.change(screen.getByLabelText("Currency internal property"), { target: { value: "currency" } });
    const local = new Date(expiresAt - new Date(expiresAt).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    fireEvent.change(screen.getByLabelText("Grant expiry (local time)"), { target: { value: local } });
    fireEvent.change(screen.getByLabelText("Maximum provider calls, including verification"), { target: { value: "3" } });
    const prepare = screen.getByRole("button", { name: "Prepare private draft" });
    expect(prepare).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByLabelText(/I attest that I created/)); fireEvent.click(prepare);
    await screen.findByText(/Private draft saved/);
    const writes = send.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0]?.[1]?.body))).toMatchObject({ accountId: grant.accountId, selection: grant.selection, maxCalls: 3 });
    expect(token.value).toBe(""); expect(send.mock.calls.some(([p]) => String(p).endsWith("/enable"))).toBe(false);
  });
  it("survives Strict Mode setup replay and needs an explicit token attestation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...hubspotScope, available: true, grants: [] })));
    render(<StrictMode><FounderHubSpotReads workspaceId={HUBSPOT_WORKSPACE} actorId={HUBSPOT_ACTOR} onClose={() => {}} /></StrictMode>);
    await screen.findByText("Prepare a private HubSpot draft"); expect(screen.getByRole("button", { name: "Refresh HubSpot access" })).toHaveProperty("disabled", false);
    expect((screen.getByLabelText("HubSpot static/private-app token") as HTMLInputElement).type).toBe("password"); expect(screen.getByRole("button", { name: "Prepare private draft" })).toHaveProperty("disabled", true);
  });
  it("clears a detached token input on close", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...hubspotScope, available: true, grants: [] })));
    const view = render(<FounderHubSpotReads workspaceId={HUBSPOT_WORKSPACE} actorId={HUBSPOT_ACTOR} onClose={() => {}} />); await screen.findByText("Prepare a private HubSpot draft");
    const input = screen.getByLabelText("HubSpot static/private-app token") as HTMLInputElement; fireEvent.change(input, { target: { value: "fixture-token-never-real" } });
    fireEvent.click(screen.getByLabelText(/I attest that I created/)); expect(input.value).toBe("fixture-token-never-real"); view.unmount(); expect(input.value).toBe("");
  });
  it("requires separate exact verified account and quota reviews before enable", async () => {
    const g = { ...hubspotGrant(), state: "verified" as const, currency: "USD", timezoneName: "UTC", usedCalls: 1 };
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => String(url).endsWith(g.id) ? Response.json({ ...hubspotScope, grant: g, receipts: [] }) : Response.json({ ...hubspotScope, available: true, grants: [g] })));
    render(<FounderHubSpotReads workspaceId={HUBSPOT_WORKSPACE} actorId={HUBSPOT_ACTOR} onClose={() => {}} />); fireEvent.click(await screen.findByRole("button", { name: "Review grant" }));
    const enable = await screen.findByRole("button", { name: "Enable exact HubSpot reads" }); expect(enable).toHaveProperty("disabled", true); fireEvent.click(screen.getByLabelText(/I reviewed this exact portal/)); expect(enable).toHaveProperty("disabled", true); fireEvent.click(screen.getByLabelText(/I authorize the exact daily reads/)); expect(enable).toHaveProperty("disabled", false);
  });
  it("discards an old account response after switching actor", async () => {
    let release!: (value: Response) => void; const held = new Promise<Response>((resolve) => { release = resolve; }); let n = 0; const next = "other@example.test";
    vi.stubGlobal("fetch", vi.fn(async () => ++n === 1 ? held : Response.json({ ...hubspotScope, actorId: next, available: true, grants: [] })));
    const view = render(<FounderHubSpotReads workspaceId={HUBSPOT_WORKSPACE} actorId={HUBSPOT_ACTOR} onClose={() => {}} />); view.rerender(<FounderHubSpotReads workspaceId={HUBSPOT_WORKSPACE} actorId={next} onClose={() => {}} />); await screen.findByText("Prepare a private HubSpot draft");
    await act(async () => { release(Response.json({ ...hubspotScope, available: true, grants: [hubspotGrant()] })); }); expect(screen.queryByText(/123456789/)).toBeNull();
  });
  it("requires refresh if a verification finishes after the tab is hidden", async () => {
    const grant = hubspotGrant(); let finish!: (value: Response) => void; const held = new Promise<Response>((resolve) => { finish = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => init?.method === "POST" ? held : String(path).endsWith(grant.id) ? Response.json({ ...hubspotScope, grant, receipts: [] }) : Response.json({ ...hubspotScope, available: true, grants: [grant] })));
    render(<FounderHubSpotReads workspaceId={HUBSPOT_WORKSPACE} actorId={HUBSPOT_ACTOR} onClose={() => {}} />); fireEvent.click(await screen.findByRole("button", { name: "Review grant" })); fireEvent.click(await screen.findByRole("button", { name: "Verify exact HubSpot account" }));
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden"); fireEvent(document, new Event("visibilitychange"));
    await act(async () => { finish(Response.json({ ...hubspotScope, grant: { ...grant, state: "verified", currency: "USD", timezoneName: "UTC", usedCalls: 1, digest: "a".repeat(64) } })); });
    expect(screen.getByText(/Refresh current state before another action/)).toBeTruthy(); expect(screen.queryByRole("button", { name: "Enable exact HubSpot reads" })).toBeNull(); visibility.mockRestore();
  });
});
