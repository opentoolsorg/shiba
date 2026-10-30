// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CapabilityCatalogItem } from "./CapabilityCatalog";
import { CapabilityCatalog } from "./CapabilityCatalog";

afterEach(() => cleanup());

const fixtures: CapabilityCatalogItem[] = [
  {
    id: "github",
    name: "GitHub",
    kind: "connector",
    status: "tested",
    category: "Code hosting",
    summary: "Read repository issues and publish pull requests.",
    description: "Connect repository data and pull request actions.",
    requestedScopes: ["repo:status", "pull_requests:write"],
    capabilities: ["Read issues", "Publish pull requests"],
    authNote: "Configured credentials are present; live access has not been verified.",
  },
  {
    id: "linear",
    name: "Linear",
    kind: "connector",
    status: "unsupported",
    category: "Project management",
    summary: "Issue sync is not available in this deployment.",
    capabilities: ["Issue sync"],
  },
  {
    id: "filesystem",
    name: "Filesystem MCP",
    kind: "mcp",
    status: "tested",
    category: "Developer tools",
    summary: "Expose workspace files to a tool client.",
    capabilities: ["List files", "Read files"],
  },
  {
    id: "review-skill",
    name: "Review checklist",
    kind: "skill",
    status: "planned",
    category: "Code review",
    summary: "A procedure for reviewing pull requests.",
    description: "An instruction bundle that describes a repeatable review procedure.",
    capabilities: ["Review procedure"],
  },
];

describe("CapabilityCatalog", () => {
  it("shows distinct status evidence and skill/tool descriptions", () => {
    render(<CapabilityCatalog items={fixtures} />);

    expect(screen.getAllByText("Configured").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Test passed").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Unsupported").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Planned").length).toBeGreaterThan(0);
    expect(screen.getByText(/Skills describe procedures; tools and connectors expose capabilities\./)).toBeTruthy();
  });

  it("searches and filters by type and status without inventing counts", () => {
    render(<CapabilityCatalog items={fixtures} />);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search capabilities" }), { target: { value: "workspace" } });
    expect(screen.getByRole("button", { name: /Filesystem MCP/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /GitHub/ })).toBeNull();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search capabilities" }), { target: { value: "" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by type" }), { target: { value: "skill" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by status" }), { target: { value: "planned" } });
    expect(screen.getByRole("button", { name: /Review checklist/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Filesystem MCP/ })).toBeNull();
    expect(screen.queryByText(/items? available/i)).toBeNull();
  });

  it("shows a clear empty state when the search has no match", () => {
    render(<CapabilityCatalog items={fixtures} />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search capabilities" }), { target: { value: "no such capability" } });
    expect(screen.getByRole("status").textContent).toBe("No capabilities match these filters.");
    expect(screen.queryByRole("button", { name: /GitHub/ })).toBeNull();
  });

  it("shows requested scopes and invokes only supplied action callbacks", () => {
    const onConfigure = vi.fn();
    const onReconnect = vi.fn();
    const onCheckHealth = vi.fn();
    render(<CapabilityCatalog items={fixtures} selectedId="github" onConfigure={onConfigure} onReconnect={onReconnect} onCheckHealth={onCheckHealth} />);

    expect(screen.getByText("repo:status")).toBeTruthy();
    expect(screen.getByText("pull_requests:write")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Configure" }));
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    fireEvent.click(screen.getByRole("button", { name: "Check health" }));
    expect(onConfigure).toHaveBeenCalledWith(fixtures[0]);
    expect(onReconnect).toHaveBeenCalledWith(fixtures[0]);
    expect(onCheckHealth).toHaveBeenCalledWith(fixtures[0]);
  });

  it("keeps auth and health actions absent when no callbacks are provided", () => {
    render(<CapabilityCatalog items={fixtures} selectedId="github" />);
    expect(screen.queryByRole("button", { name: "Configure" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Check health" })).toBeNull();
    expect(screen.getByText("Actions are not available for this capability.")).toBeTruthy();
  });

  it("does not expose configuration, reconnect, or health actions for unsupported capabilities", () => {
    const onConfigure = vi.fn();
    const onReconnect = vi.fn();
    const onCheckHealth = vi.fn();
    render(<CapabilityCatalog items={fixtures} selectedId="linear" onConfigure={onConfigure} onReconnect={onReconnect} onCheckHealth={onCheckHealth} />);

    expect(screen.queryByRole("button", { name: "Configure" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Check health" })).toBeNull();
    expect(screen.getByText("Actions are not available for this capability.")).toBeTruthy();
    expect(onConfigure).not.toHaveBeenCalled();
    expect(onReconnect).not.toHaveBeenCalled();
    expect(onCheckHealth).not.toHaveBeenCalled();
  });
});
