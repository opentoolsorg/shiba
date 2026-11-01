// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WorkspaceConnectorsPanel } from "./WorkspaceConnectorsPanel";
import { extensionsApi } from "../extensions-api";
import type { IntegrationBindingInputs } from "../integration-connection-bindings";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  extensionsApi.resetStubFixtures();
  extensionsApi.useStubs(true);
});

const mockBindingInputs: IntegrationBindingInputs = {
  setupLoading: false,
  mailboxCount: 0,
  mailboxLoading: false,
  gmailConnected: false,
  gmailLoading: false,
  externalMcpServerCount: 0,
  externalMcpCatalogConnections: [],
  externalMcpLoading: false,
};

describe("WorkspaceConnectorsPanel", () => {
  it("renders connectors for the personal view by default", async () => {
    render(<WorkspaceConnectorsPanel bindingInputs={mockBindingInputs} />);
    expect(await screen.findByText("linear")).toBeTruthy();
    expect(screen.getByText(/Personal Linear Account/)).toBeTruthy();
  });

  it("switches between Personal, Workspace, and Archived connector views", async () => {
    render(<WorkspaceConnectorsPanel bindingInputs={mockBindingInputs} />);
    expect(await screen.findByText("linear")).toBeTruthy();

    // Switch to Workspace view
    fireEvent.click(screen.getByRole("tab", { name: "Workspace" }));
    expect(await screen.findByText("slack")).toBeTruthy();
    expect(screen.queryByText("linear")).toBeNull();

    // Switch to Archived view
    fireEvent.click(screen.getByRole("tab", { name: "Archived" }));
    expect(await screen.findByText(/No archived connectors/)).toBeTruthy();
  });

  it("filters connectors by search query", async () => {
    render(<WorkspaceConnectorsPanel bindingInputs={mockBindingInputs} />);
    await screen.findByText("linear");

    const searchInput = screen.getByLabelText("Search connectors");
    fireEvent.change(searchInput, { target: { value: "nomatch" } });
    expect(await screen.findByText(/No connectors match/)).toBeTruthy();

    fireEvent.change(searchInput, { target: { value: "linear" } });
    expect(await screen.findByText("linear")).toBeTruthy();
  });

  it("moves a connector between personal and workspace scopes", async () => {
    render(<WorkspaceConnectorsPanel bindingInputs={mockBindingInputs} />);
    expect(await screen.findByText("linear")).toBeTruthy();

    const moveBtn = screen.getByRole("button", { name: "Move to Workspace" });
    fireEvent.click(moveBtn);
    expect(await screen.findByText(/linear moved to Workspace/)).toBeTruthy();

    // Switch to Workspace tab to confirm
    fireEvent.click(screen.getByRole("tab", { name: "Workspace" }));
    expect(await screen.findByText("linear")).toBeTruthy();
  });

  it("archives and restores a connector", async () => {
    render(<WorkspaceConnectorsPanel bindingInputs={mockBindingInputs} />);
    expect(await screen.findByText("linear")).toBeTruthy();

    const archiveBtn = screen.getByRole("button", { name: "Archive" });
    fireEvent.click(archiveBtn);
    expect(await screen.findByText(/linear archived/)).toBeTruthy();

    // Switch to Archived view
    fireEvent.click(screen.getByRole("tab", { name: "Archived" }));
    expect(await screen.findByText("linear")).toBeTruthy();

    // Restore connector
    const restoreBtn = await screen.findByRole("button", { name: "Restore" });
    await screen.findByText(/Archived connectors/);
    fireEvent.click(restoreBtn);
    expect(await screen.findByText(/linear restored/)).toBeTruthy();
  });

  it("opens the catalog modal via browse button", async () => {
    render(<WorkspaceConnectorsPanel bindingInputs={mockBindingInputs} />);
    await screen.findByText("linear");

    const browseModalBtn = screen.getByRole("button", { name: "Browse catalog modal" });
    fireEvent.click(browseModalBtn);
    expect(await screen.findByRole("dialog", { name: "Browse integration catalog" })).toBeTruthy();
  });
});
