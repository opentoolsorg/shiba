// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EmployeeWorkspace } from "./EmployeeWorkspace";
import type { CustomAgentWire } from "./CustomAgentsView";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const boss: CustomAgentWire = { id: "boss-1", slug: "boss", version: 1, config: { name: "Boss", instructions: "Lead.", harness: "opencode" } };
const agent: CustomAgentWire = { id: "fin-1", slug: "finance-clerk", version: 2, config: { name: "Ledger", title: "AP Clerk", instructions: "Review approved invoices.", harness: "opencode", roleTemplateId: "finance", department: "finance", codingModel: "gpt-review", expectedDeliverables: ["report.pdf"], reportsTo: { kind: "agent", agentId: "boss-1" } } };

function stubPolicy() {
  const fetchMock = vi.fn(async () => Response.json({ toolScopes: ["mcp:shiba:gmail"], grants: [{ capabilityId: "mcp:shiba:gmail", resourceId: "inbox", lifecycle: "active" }, { capabilityId: "mcp:shiba:gmail", resourceId: "old", lifecycle: "revoked" }] }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("EmployeeWorkspace", () => {
  it("shows the header and switches tabs with proper tab semantics", () => {
    render(<EmployeeWorkspace employee={agent} employees={[boss, agent]} onOpenConversation={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Ledger" })).toBeTruthy();
    // Department matches the role label here, so it is not repeated.
    expect(screen.queryByText("finance department")).toBeNull();
    expect(screen.getAllByRole("tab")).toHaveLength(4);
    expect(screen.getByRole("tab", { name: "Conversation" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "Role & workflow" }));
    expect(screen.getByRole("tab", { name: "Role & workflow" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Review approved invoices.")).toBeTruthy();
    expect(screen.getByText("report.pdf")).toBeTruthy();
    expect(screen.getByText("gpt-review")).toBeTruthy();
    expect(screen.getByText("Boss")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("tablist"), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Tools & access" }).getAttribute("aria-selected")).toBe("true");
  });

  it("opens the conversation through the callback", () => {
    const onOpenConversation = vi.fn();
    render(<EmployeeWorkspace employee={agent} onOpenConversation={onOpenConversation} />);
    fireEvent.click(screen.getByRole("button", { name: "Open conversation" }));
    expect(onOpenConversation).toHaveBeenCalledWith("fin-1");
  });

  it("lists only active tool grants and offers Tool policy when the callback exists", async () => {
    const fetchMock = stubPolicy();
    const onOpenToolPolicy = vi.fn();
    render(<EmployeeWorkspace employee={agent} onOpenToolPolicy={onOpenToolPolicy} />);
    fireEvent.click(screen.getByRole("tab", { name: "Tools & access" }));
    await screen.findByText("gmail · inbox");
    expect(screen.queryByText("gmail · old")).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("/api/employee-tools/fin-1/policy", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "Manage in Tool policy" }));
    expect(onOpenToolPolicy).toHaveBeenCalledWith("fin-1");
  });

  it("hides Tool policy and explains where grants live when the callback is absent or in a team workspace", async () => {
    const fetchMock = stubPolicy();
    const { unmount } = render(<EmployeeWorkspace employee={agent} />);
    fireEvent.click(screen.getByRole("tab", { name: "Tools & access" }));
    await screen.findByText("gmail · inbox");
    expect(screen.queryByRole("button", { name: "Manage in Tool policy" })).toBeNull();
    expect(screen.getByText("Tool grants are managed in a personal workspace.")).toBeTruthy();
    unmount();
    fetchMock.mockClear();
    render(<EmployeeWorkspace employee={agent} workspaceId="ws-1" onOpenToolPolicy={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Tools & access" }));
    expect(screen.queryByRole("button", { name: "Manage in Tool policy" })).toBeNull();
    expect(screen.getByText("Tool grants are managed in a personal workspace.")).toBeTruthy();
    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled());
  });

  it("states an unavailable policy without implying access", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 500 })));
    render(<EmployeeWorkspace employee={agent} />);
    fireEvent.click(screen.getByRole("tab", { name: "Tools & access" }));
    await screen.findByText("Tool policy is unavailable; no tool access is implied.");
  });

  it("shows passed outputs, an honest empty state, or only the link-out", () => {
    const onOpenOutputs = vi.fn();
    const { rerender } = render(<EmployeeWorkspace employee={agent} outputs={[{ id: "o1", title: "March close" }]} onOpenOutputs={onOpenOutputs} />);
    fireEvent.click(screen.getByRole("tab", { name: "Outputs" }));
    expect(screen.getByText("March close")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open outputs" }));
    expect(onOpenOutputs).toHaveBeenCalledWith("fin-1");
    rerender(<EmployeeWorkspace employee={agent} outputs={[]} />);
    expect(screen.getByText("No outputs from this employee yet.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open outputs" })).toBeNull();
  });
});
