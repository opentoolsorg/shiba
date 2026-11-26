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
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]: unknown[]) => String(url).includes("/policy"))).toBe(false));
  });

  it("offers a team conversation only once the caller has chat or manage access", async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => Response.json({ level: "chat" }));
    vi.stubGlobal("fetch", fetchMock);
    const open = vi.fn();
    render(<EmployeeWorkspace employee={agent} workspaceId="ws-1" onOpenConversation={open} />);
    expect(screen.getByText("Conversations are not available from here.")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Open conversation" }));
    expect(open).toHaveBeenCalledWith("fin-1");
    expect(fetchMock).toHaveBeenCalledWith("/api/governance/employees/fin-1/access", expect.anything());
  });

  it.each(["view", "none"])("keeps the team conversation hidden for %s access", async (level) => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => Response.json({ level }));
    vi.stubGlobal("fetch", fetchMock);
    render(<EmployeeWorkspace employee={agent} workspaceId="ws-1" onOpenConversation={vi.fn()} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("button", { name: "Open conversation" })).toBeNull();
  });

  it("states an unavailable policy without implying access", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 500 })));
    render(<EmployeeWorkspace employee={agent} />);
    fireEvent.click(screen.getByRole("tab", { name: "Tools & access" }));
    await screen.findByText("Tool policy is unavailable; no tool access is implied.");
  });

  it("offers the Outputs link-out only when wired", () => {
    const onOpenOutputs = vi.fn();
    const { rerender } = render(<EmployeeWorkspace employee={agent} onOpenOutputs={onOpenOutputs} />);
    fireEvent.click(screen.getByRole("tab", { name: "Outputs" }));
    expect(screen.getByText("Outputs and handoffs are listed in the Outputs page.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open outputs" }));
    expect(onOpenOutputs).toHaveBeenCalledWith("fin-1");
    rerender(<EmployeeWorkspace employee={agent} />);
    expect(screen.queryByRole("button", { name: "Open outputs" })).toBeNull();
  });

  it("lists direct reports, opens them, and delegates through the approval-gated conversation callback", () => {
    const report: CustomAgentWire = { id: "rep-1", slug: "analyst", version: 1, config: { name: "Analyst", instructions: "Analyze.", harness: "opencode", reportsTo: { kind: "agent", agentId: "boss-1" } } };
    const onOpenEmployee = vi.fn();
    const onDelegateTask = vi.fn();
    render(<EmployeeWorkspace employee={boss} employees={[boss, report, { ...agent, id: "other-1", config: { ...agent.config, reportsTo: undefined } }]} onOpenEmployee={onOpenEmployee} onDelegateTask={onDelegateTask} />);
    fireEvent.click(screen.getByRole("tab", { name: "Role & workflow" }));
    const list = screen.getByRole("list", { name: "Direct reports" });
    expect(list.textContent).toContain("Analyst");
    expect(list.textContent).not.toContain("Ledger");
    expect(screen.getByText(/still needs your approval/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Analyst" }));
    expect(onOpenEmployee).toHaveBeenCalledWith(report);
    fireEvent.click(screen.getByRole("button", { name: "Delegate task to Analyst" }));
    expect(onDelegateTask).toHaveBeenCalledWith(report);
  });

  it("omits the Team section without reports and hides Delegate in team scope without chat access", async () => {
    const report: CustomAgentWire = { id: "rep-1", slug: "analyst", version: 1, config: { name: "Analyst", instructions: "Analyze.", harness: "opencode", reportsTo: { kind: "agent", agentId: "boss-1" } } };
    const { unmount } = render(<EmployeeWorkspace employee={agent} employees={[boss, report, agent]} />);
    fireEvent.click(screen.getByRole("tab", { name: "Role & workflow" }));
    expect(screen.queryByRole("list", { name: "Direct reports" })).toBeNull();
    unmount();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json({ level: url.includes("boss-1") ? "manage" : "view" })));
    render(<EmployeeWorkspace employee={boss} employees={[boss, report]} workspaceId="ws_aaaaaaaaaaaaaaaaaaaaaaaa" onDelegateTask={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Role & workflow" }));
    await waitFor(() => expect(screen.getByRole("list", { name: "Direct reports" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Delegate task to Analyst" })).toBeNull();
  });
});
