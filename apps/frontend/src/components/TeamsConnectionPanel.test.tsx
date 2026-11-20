// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IntegrationsView } from "./IntegrationsView";
import { TeamsConnectionPanel } from "./TeamsConnectionPanel";

const workspaceId = `ws_${"a".repeat(24)}`;
const owner = "owner@example.test";
const endpoint = "/api/teams/connection";
const manage = "Manage Microsoft Teams connection";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Microsoft Teams workspace connection", () => {
  it("opens only on request for a native workspace owner and clears the panel on workspace switch", async () => {
    const fetcher = vi.fn(async (path: RequestInfo | URL) => Response.json(String(path) === endpoint
      ? { status: "not_configured", installed: false } : {}));
    vi.stubGlobal("fetch", fetcher);
    const view = render(<IntegrationsView actorId={owner} nativeSession />);
    expect(screen.queryByRole("button", { name: manage })).toBeNull();
    view.rerender(<IntegrationsView workspaceId={workspaceId} actorId={owner} workspaceRole="member" nativeSession />);
    expect(screen.queryByRole("button", { name: manage })).toBeNull();
    view.rerender(<IntegrationsView workspaceId={workspaceId} actorId={owner} workspaceRole="owner" />);
    expect(screen.queryByRole("button", { name: manage })).toBeNull();
    view.rerender(<IntegrationsView workspaceId={workspaceId} actorId={owner} workspaceRole="owner" nativeSession />);
    expect(fetcher.mock.calls.some(([path]) => path === endpoint)).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: manage }));
    const panel = await screen.findByRole("region", { name: "Microsoft Teams connection" });
    expect(await within(panel).findByText("Not configured")).toBeTruthy();
    expect(within(panel).getByRole("link", { name: "Teams setup guide" }).getAttribute("href")).toBe("/docs/teams-setup/");
    expect(within(panel).queryByRole("button", { name: /Enable Teams/ })).toBeNull();
    expect(within(panel).queryByRole("textbox")).toBeNull();
    view.rerender(<IntegrationsView workspaceId={`ws_${"b".repeat(24)}`} actorId={owner} workspaceRole="owner" nativeSession />);
    expect(screen.queryByRole("region", { name: "Microsoft Teams connection" })).toBeNull();
    expect(screen.getByRole("button", { name: manage }).getAttribute("aria-expanded")).toBe("false");
    expect(fetcher.mock.calls.filter(([path]) => path === endpoint)).toHaveLength(1);
  });

  it("enables and disables only in Shiba and reads observed installation separately", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ status: "disconnected", installed: false }))
      .mockResolvedValueOnce(Response.json({ status: "connected", installed: false }))
      .mockResolvedValueOnce(Response.json({ status: "connected", installed: true }))
      .mockResolvedValueOnce(Response.json({ status: "disconnected", installed: true }));
    vi.stubGlobal("fetch", fetcher);
    render(<TeamsConnectionPanel workspaceId={workspaceId} />);
    fireEvent.click(await screen.findByRole("button", { name: "Enable Teams in Shiba" }));
    expect(await screen.findByText("Enabled")).toBeTruthy();
    expect(screen.getByText("Not yet observed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh Teams status" }));
    expect(await screen.findByText("Installation observed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Disable Teams in Shiba" }));
    expect(await screen.findByText("Disabled")).toBeTruthy();
    expect(screen.getByText("Installation observed")).toBeTruthy();

    expect(fetcher.mock.calls.map(([path, init]) => [
      path, init?.method, new Headers(init?.headers).get("X-Shiba-Workspace"),
      new Headers(init?.headers).get("Content-Type"), init?.body, init?.credentials,
    ])).toEqual([
      [endpoint, "GET", workspaceId, null, undefined, "same-origin"],
      [endpoint, "POST", workspaceId, "application/json", '{"action":"connect"}', "same-origin"],
      [endpoint, "GET", workspaceId, null, undefined, "same-origin"],
      [endpoint, "POST", workspaceId, "application/json", '{"action":"disconnect"}', "same-origin"],
    ]);
  });

  it("blocks duplicate writes and requires a refresh after an unconfirmed mutation", async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ status: "disconnected", installed: false }))
      .mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce(Response.json({ status: "error", installed: false, error: "Teams is temporarily unavailable." }));
    vi.stubGlobal("fetch", fetcher);
    render(<TeamsConnectionPanel workspaceId={workspaceId} />);
    const enable = await screen.findByRole("button", { name: "Enable Teams in Shiba" });
    const refresh = screen.getByRole("button", { name: "Refresh Teams status" });
    fireEvent.click(enable);
    fireEvent.click(enable);
    expect(enable.hasAttribute("disabled")).toBe(true);
    expect(refresh.hasAttribute("disabled")).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await act(async () => finish(Response.json({ error: "Workspace owner session required." }, { status: 403 })));
    expect(screen.getByRole("alert").textContent).toBe("Workspace owner session required.");
    expect(screen.queryByRole("button", { name: "Enable Teams in Shiba" })).toBeNull();
    fireEvent.click(refresh);
    expect(await screen.findByText("Teams is temporarily unavailable.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /able Teams in Shiba/ })).toBeNull();
  });
});
