// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserLoginVault } from "./BrowserLoginVault";

const workspaceId = `ws_${"a".repeat(24)}`;
const login = {
  id: `bl_${"b".repeat(32)}`, label: "Example Portal", origin: "https://portal.example.test",
  username: "reviewer@example.test", updatedAt: 1,
};
const path = "/api/browser-logins";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("BrowserLoginVault", () => {
  it("creates a personal login, keeps secrets out of the returned list, copies only the ID, and confirms removal", async () => {
    let logins: (typeof login)[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        logins = [login];
        return Response.json({ login }, { status: 201 });
      }
      if (init?.method === "DELETE") {
        logins = [];
        return Response.json({ deleted: true });
      }
      return Response.json({ logins: logins.map((entry) => ({ ...entry, password: "fixture-should-not-render" })) });
    });
    vi.stubGlobal("fetch", fetchMock);
    const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    render(<BrowserLoginVault />);
    await screen.findByText("No saved browser logins yet.");
    fireEvent.click(screen.getByRole("button", { name: "Add login" }));
    const form = screen.getByRole("form", { name: "Add browser login" });
    fireEvent.change(within(form).getByLabelText("Label"), { target: { value: login.label } });
    fireEvent.change(within(form).getByLabelText("Site origin"), { target: { value: `${login.origin}/` } });
    fireEvent.change(within(form).getByLabelText("Username"), { target: { value: login.username } });
    const field = within(form).getByLabelText<HTMLInputElement>("Password");
    fireEvent.change(field, { target: { value: "fixture-password" } });
    fireEvent.submit(form);
    expect(field.value).toBe("");
    await screen.findByText(login.id);
    expect(screen.queryByText("fixture-should-not-render")).toBeNull();
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(path, expect.objectContaining({
      method: "POST", cache: "no-store", body: JSON.stringify({
        origin: login.origin, label: login.label, username: login.username, password: "fixture-password",
      }),
    }));

    fireEvent.click(screen.getByRole("button", { name: `Copy login ID for ${login.label}` }));
    await screen.findByText("Login ID copied.");
    expect(copy).toHaveBeenCalledWith(login.id);
    fireEvent.click(screen.getByRole("button", { name: `Remove ${login.label}` }));
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Confirm remove" }));
    expect(await screen.findByText("Saved login removed.")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(`${path}/${login.id}`, expect.objectContaining({ method: "DELETE" }));
  });

  it("uses workspace selectors, omits unchanged fields and password, and clears TOTP only when asked", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "PATCH" ? Response.json({ login }) : Response.json({ logins: [login] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<BrowserLoginVault workspaceId={workspaceId} workspaceRole="admin" workspaceName="Example team" />);
    await screen.findByText(login.id);
    expect(fetchMock).toHaveBeenCalledWith(`${path}?workspaceId=${workspaceId}`, expect.objectContaining({
      headers: { "X-Shiba-Workspace": workspaceId },
    }));
    fireEvent.click(screen.getByRole("button", { name: `Edit ${login.label}` }));
    const form = screen.getByRole("form", { name: "Edit browser login" });
    expect(within(form).getByLabelText<HTMLInputElement>("Password").value).toBe("");
    expect(within(form).getByLabelText<HTMLInputElement>("TOTP setup key (optional)").value).toBe("");
    fireEvent.change(within(form).getByLabelText("Label"), { target: { value: "Renamed portal" } });
    fireEvent.click(within(form).getByLabelText("Clear saved TOTP key"));
    fireEvent.submit(form);
    expect(await screen.findByText("Saved login updated.")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(`${path}/${login.id}?workspaceId=${workspaceId}`, expect.objectContaining({
      method: "PATCH", headers: { "X-Shiba-Workspace": workspaceId, "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Renamed portal", totpSecret: null }),
    }));
  });

  it("requires both replacement decisions to move to a new site, and removes the form and data on scope change", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "PATCH" ? Response.json({ login }) : Response.json({ logins: [login] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<BrowserLoginVault workspaceId={workspaceId} workspaceRole="owner" />);
    fireEvent.click(await screen.findByRole("button", { name: `Edit ${login.label}` }));
    const form = screen.getByRole("form", { name: "Edit browser login" });
    fireEvent.change(within(form).getByLabelText("Site origin"), { target: { value: "https://other.example.test" } });
    fireEvent.change(within(form).getByLabelText("Password"), { target: { value: "fixture-replacement" } });
    fireEvent.submit(form);
    expect(screen.getByRole("alert").textContent).toContain("either a new TOTP key or clearing");
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
    fireEvent.click(within(form).getByLabelText("Clear saved TOTP key"));
    fireEvent.submit(form);
    await screen.findByText("Saved login updated.");
    expect(fetchMock).toHaveBeenCalledWith(`${path}/${login.id}?workspaceId=${workspaceId}`, expect.objectContaining({
      method: "PATCH", body: JSON.stringify({ origin: "https://other.example.test", password: "fixture-replacement", totpSecret: null }),
    }));

    const callsBefore = fetchMock.mock.calls.length;
    rerender(<BrowserLoginVault workspaceId={workspaceId} workspaceRole="member" />);
    expect(screen.getByText("Only workspace owners and admins can manage browser logins.")).toBeTruthy();
    expect(screen.queryByText(login.id)).toBeNull();
    expect(screen.queryByRole("button", { name: "Add login" })).toBeNull();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(callsBefore));
  });
});
