// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NotificationsPanel } from "./NotificationsPanel";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("NotificationsPanel", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/workspace-notifications" && (!init?.method || init.method === "GET")) {
          return Response.json({
            notifications: [
              {
                notificationId: "ntf_1",
                kind: "mention",
                title: "You were mentioned",
                body: "Check the channel",
                readAt: null,
                createdAt: 1,
              },
            ],
          });
        }
        if (path === "/api/workspace-notifications/ntf_1/read" && init?.method === "POST") {
          return Response.json({ read: true });
        }
        return Response.json({ error: "not found" }, { status: 404 });
      }),
    );
  });

  it("renders bell with unread badge and marks notification read on click", async () => {
    render(<NotificationsPanel workspaceId="ws_test" />);

    await waitFor(() => expect(screen.getByLabelText(/Notifications, 1 unread/)).toBeTruthy());

    fireEvent.click(screen.getByLabelText(/Notifications, 1 unread/));
    await screen.findByRole("dialog", { name: "Workspace notifications" });
    expect(screen.getByText("You were mentioned")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /You were mentioned/ }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/workspace-notifications/ntf_1/read",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });
});