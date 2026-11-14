// @vitest-environment happy-dom
import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceConnectorsPanel } from "./WorkspaceConnectorsPanel";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WorkspaceConnectorsPanel operator review gate", () => {
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