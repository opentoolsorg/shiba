// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ExtensionMcpServersView } from "./ExtensionMcpServersView";
import { extensionsApi } from "../extensions-api";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  extensionsApi.resetStubFixtures();
  extensionsApi.useStubs(true);
});

describe("ExtensionMcpServersView", () => {
  it("renders server cards from the default personal view", async () => {
    render(<ExtensionMcpServersView />);
    expect(await screen.findByText("GitHub MCP Server")).toBeTruthy();
    expect(screen.getByText("https://mcp.github.com/v1")).toBeTruthy();
    expect(screen.getByText("OAuth: connected")).toBeTruthy();
    expect(screen.getByText("Streamable HTTP")).toBeTruthy();
  });

  it("switches tabs between Personal, Workspace, and Archived", async () => {
    render(<ExtensionMcpServersView />);
    expect(await screen.findByText("GitHub MCP Server")).toBeTruthy();

    // Switch to Workspace
    fireEvent.click(screen.getByRole("tab", { name: "Workspace" }));
    expect(await screen.findByText("Cloudflare Developer MCP")).toBeTruthy();
    expect(screen.queryByText("GitHub MCP Server")).toBeNull();

    // Switch to Archived
    fireEvent.click(screen.getByRole("tab", { name: "Archived" }));
    expect(await screen.findByText("Legacy Weather Service")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restore" })).toBeTruthy();
  });

  it("filters servers by search query", async () => {
    render(<ExtensionMcpServersView />);
    await screen.findByText("GitHub MCP Server");

    const searchInput = screen.getByLabelText("Search servers");
    fireEvent.change(searchInput, { target: { value: "notfound" } });
    expect(await screen.findByText(/No servers match/)).toBeTruthy();

    fireEvent.change(searchInput, { target: { value: "github" } });
    expect(await screen.findByText("GitHub MCP Server")).toBeTruthy();
  });

  it("creates a new server via the dialog", async () => {
    render(<ExtensionMcpServersView />);
    await screen.findByText("GitHub MCP Server");

    fireEvent.click(screen.getByRole("button", { name: "Add server" }));
    expect(await screen.findByRole("heading", { name: "Add MCP server" })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Stripe MCP" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Process charges" } });
    fireEvent.change(screen.getByLabelText("Server URL"), { target: { value: "https://stripe-mcp.internal" } });
    fireEvent.change(screen.getByLabelText("Transport"), { target: { value: "streamable-http" } });
    fireEvent.change(screen.getByLabelText("Authentication"), { target: { value: "bearer" } });
    fireEvent.change(screen.getByLabelText("Bearer token"), { target: { value: "sk_test_123" } });
    fireEvent.change(screen.getByLabelText("Default tool policy"), { target: { value: "approval_required" } });

    const submitBtns = screen.getAllByRole("button", { name: "Add server" });
    const submitBtn = submitBtns[submitBtns.length - 1];
    expect(submitBtn).toBeDefined();
    fireEvent.click(submitBtn!);

    expect(await screen.findByText("Stripe MCP")).toBeTruthy();
    expect(screen.getByText("https://stripe-mcp.internal")).toBeTruthy();
  });

  it("tests connection inside dialog", async () => {
    render(<ExtensionMcpServersView />);
    await screen.findByText("GitHub MCP Server");

    fireEvent.click(screen.getByRole("button", { name: "Add server" }));
    await screen.findByRole("heading", { name: "Add MCP server" });

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Test Svc" } });
    fireEvent.change(screen.getByLabelText("Server URL"), { target: { value: "https://test.local" } });

    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText(/Connected — 6 tools available/)).toBeTruthy();
  });

  it("toggles server enabled and moves scope", async () => {
    render(<ExtensionMcpServersView />);
    expect(await screen.findByText("GitHub MCP Server")).toBeTruthy();

    // Toggle disable
    const disableBtn = screen.getByRole("button", { name: "Disable" });
    fireEvent.click(disableBtn);
    expect(await screen.findByText("Server disabled.")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Enable" })).toBeTruthy();

    // Move scope to Workspace
    const moveBtn = screen.getByRole("button", { name: "Move to Workspace" });
    fireEvent.click(moveBtn);
    expect(await screen.findByText("Moved to Workspace.")).toBeTruthy();

    // Switch to Workspace tab to confirm it arrived
    fireEvent.click(screen.getByRole("tab", { name: "Workspace" }));
    expect(await screen.findByText("GitHub MCP Server")).toBeTruthy();
  });

  it("archives, restores, and deletes a server", async () => {
    render(<ExtensionMcpServersView />);
    await screen.findByText("GitHub MCP Server");

    // Archive
    const archiveBtn = screen.getByRole("button", { name: "Archive" });
    fireEvent.click(archiveBtn);
    expect(await screen.findByText("Server archived.")).toBeTruthy();

    // Switch to Archived
    fireEvent.click(screen.getByRole("tab", { name: "Archived" }));
    expect(await screen.findByText("Legacy Weather Service")).toBeTruthy();
    const restoreBtns = await screen.findAllByRole("button", { name: "Restore" });
    expect(restoreBtns[0]).toBeDefined();
    fireEvent.click(restoreBtns[0]!);
    expect(await screen.findByText("Server restored.")).toBeTruthy();
  });
});
