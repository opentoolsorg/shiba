// @vitest-environment happy-dom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceConnectorsPanel } from "./WorkspaceConnectorsPanel";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WorkspaceConnectorsPanel operator review gate", () => {
  it("discards pending personal setup status when switching workspace scope", async () => {
    const workspaceId = `ws_${"a".repeat(24)}`;
    let resolveSetup!: (response: Response) => void;
    const pendingSetup = new Promise<Response>((resolve) => { resolveSetup = resolve; });
    const fetcher = vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url === "/api/setup/status") return pendingSetup;
      return Response.json({ ok: true, workspaceId, canManage: true, connections: [], items: [] });
    });
    vi.stubGlobal("fetch", fetcher);
    const props = {
      actorId: "alice@example.test",
      bindingInputs: {
        setupLoading: true, mailboxLoading: true, gmailLoading: true, externalMcpLoading: true,
        mailboxCount: undefined, gmailConnected: null, externalMcpServerCount: undefined,
        externalMcpCatalogConnections: undefined,
      },
    };
    const view = render(<WorkspaceConnectorsPanel {...props} />);
    await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url === "/api/setup/status")).toHaveLength(1));
    view.rerender(<WorkspaceConnectorsPanel {...props} workspaceId={workspaceId} workspaceRole="owner" />);
    await waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/connections"))).toBe(true));
    await act(async () => { resolveSetup(Response.json({ deployment: { operatorReviewEnabled: true } })); });
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/setup/status")).toHaveLength(1);
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("operator-enrollment-reviews"))).toBe(false);
    fetcher.mockImplementation(async () => new Promise<Response>(() => {}));
    view.rerender(<WorkspaceConnectorsPanel {...props} />);
    await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url === "/api/setup/status")).toHaveLength(2));
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("operator-enrollment-reviews"))).toBe(false);
  });

  it("does not mount operator reviews when setup status reports disabled", async () => {
    const fetcher = vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url.includes("/api/setup/status")) {
        return Response.json({ deployment: { operatorReviewEnabled: false } });
      }
      throw new Error("reviews route should not run");
    });
    vi.stubGlobal("fetch", fetcher);
    render(
      <WorkspaceConnectorsPanel
        bindingInputs={{
          setupLoading: false,
          mailboxLoading: false,
          gmailLoading: false,
          externalMcpLoading: false,
          mailboxCount: 0,
          gmailConnected: false,
          externalMcpServerCount: 0,
          externalMcpCatalogConnections: [],
        }}
        actorId="alice@example.test"
      />,
    );
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/setup/status", expect.anything()));
    expect(fetcher.mock.calls.some((call) => String(call[0]).includes("operator-enrollment-reviews"))).toBe(false);
  });
});
