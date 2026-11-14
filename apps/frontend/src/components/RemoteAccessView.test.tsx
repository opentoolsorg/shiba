// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { RemoteAccessView } from "./RemoteAccessView";

describe("RemoteAccessView", () => {
  it("shows remote-off empty state on 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.includes("/api/computers")) return new Response(null, { status: 404 });
        if (url.includes("/api/whoami")) return Response.json({ agent: "owner" });
        return new Response(null, { status: 404 });
      }),
    );
    render(<RemoteAccessView />);
    await waitFor(() => expect(screen.getByText(/Remote access is off on this deployment/i)).toBeTruthy());
    vi.unstubAllGlobals();
  });
});