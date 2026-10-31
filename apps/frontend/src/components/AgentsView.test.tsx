// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgentsView } from "./AgentsView";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("shows the gateway, switches configuration, and filters client rows", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ principals: [
    { principal: "scout", scopes: ["email:read"], created: Date.now(), live: true },
    { principal: "builder", scopes: ["sandbox:write"], created: Date.now(), live: false },
  ] }) }));
  render(<AgentsView />);
  expect(await screen.findByText("scout")).toBeTruthy();
  expect(screen.getByText("2 clients")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "MCP gateway" })).toBeTruthy();
  expect(screen.getByText("Connection not verified")).toBeTruthy();
  expect(screen.getByRole("cell", { name: "Token active" })).toBeTruthy();
  expect(screen.getByRole("cell", { name: "Token revoked" })).toBeTruthy();
  expect(document.querySelector('img[src="/assets/harnesses/claude.svg"]')).toBeTruthy();
  const cursorIcon = document.querySelector('img[src="/assets/harnesses/cursor.svg"]');
  expect(cursorIcon).toBeTruthy();
  if (cursorIcon) fireEvent.error(cursorIcon);
  expect(document.querySelector('img[src="/assets/harnesses/cursor.svg"]')).toBeNull();
  expect(screen.getByRole("button", { name: "Cursor" }).querySelector("svg")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cursor" }));
  expect(screen.getByRole("button", { name: "Cursor" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByText(/Transport: Streamable HTTP/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Search clients" }));
  fireEvent.change(screen.getByRole("searchbox", { name: "Filter clients" }), { target: { value: "sandbox" } });
  expect(screen.queryByRole("cell", { name: "scout" })).toBeNull();
  expect(screen.getByText("builder")).toBeTruthy();
  fireEvent.change(screen.getByRole("searchbox", { name: "Filter clients" }), { target: { value: "missing" } });
  expect(screen.getByText("No matching clients")).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Open Inbox setup" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
  expect(screen.getByRole("cell", { name: "scout" })).toBeTruthy();
});

it("does not present a failed client request as an empty list", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({}, { status: 503 })));
  render(<AgentsView />);
  expect(screen.getByText("Loading clients…")).toBeTruthy();
  expect((await screen.findByRole("alert")).textContent).toContain("Could not load clients");
  expect(screen.queryByText("No clients yet")).toBeNull();
  expect(screen.queryByRole("link", { name: "Open Inbox setup" })).toBeNull();
});

it("reports unavailable clipboard support without throwing", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ principals: [] })));
  vi.stubGlobal("navigator", { clipboard: undefined });
  render(<AgentsView />);
  await screen.findByText("No clients yet");
  fireEvent.click(screen.getByRole("button", { name: "Copy URL" }));
  expect(screen.getByRole("alert").textContent).toContain("Select and copy the text instead");
});

it("clears stale copy errors on retry and resets copied feedback when switching configuration", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ principals: [] })));
  const writeText = vi.fn().mockRejectedValueOnce(new Error("Denied")).mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  render(<AgentsView />);
  await screen.findByText("No clients yet");
  fireEvent.click(screen.getByRole("button", { name: "Copy configuration" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Copy configuration" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  await screen.findByRole("button", { name: "Copied" });
  fireEvent.click(screen.getByRole("button", { name: "Cursor" }));
  expect(screen.getByRole("button", { name: "Copy configuration" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
});

it("keeps token setup reachable in the quiet empty state", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ principals: [] }) }));
  render(<AgentsView />);
  expect(await screen.findByText("No clients yet")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Open Inbox setup" }).getAttribute("href")).toBe("/?tab=inbox");
  expect(screen.getByText(/Without it, the token cannot authenticate/)).toBeTruthy();
});
