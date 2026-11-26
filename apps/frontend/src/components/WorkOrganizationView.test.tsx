// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type OrganizationEmployee, WorkOrganizationView } from "./WorkOrganizationView";

vi.mock("./AgentAvatar", () => ({
  AgentAvatar: ({ id, name, look }: { id: string; name: string; look?: { color?: string } }) => (
    <span data-testid={`avatar-${id}`} data-look-color={look?.color} role="img" aria-label={name} />
  ),
}));

afterEach(cleanup);

describe("WorkOrganizationView", () => {
  it("renders the workspace heading, subtitle and chief of staff card", () => {
    render(<WorkOrganizationView employees={[]} user={{ name: "Prince" }} />);
    expect(screen.getByRole("heading", { name: "Prince’s workspace" })).toBeDefined();
    expect(screen.getByText("Workspace agents and member chiefs of staff.")).toBeDefined();
    const chief = screen.getByTestId("organization-chief-card");
    expect(chief.textContent).toContain("Shiba");
    expect(chief.textContent).toContain("Workspace chief of staff");
    expect(screen.getByTestId("avatar-workspace-chief")).toBeDefined();
    // Both chiefs of staff use the blue Shiba brand mascot, never a generated one.
    expect(screen.getByTestId("avatar-workspace-chief").getAttribute("data-look-color")).toBe("#899bd0");
    expect(screen.getByTestId("organization-user-card").querySelector("[data-look-color]")?.getAttribute("data-look-color")).toBe("#899bd0");
  });

  it("renders the member chief card with the private note and falls back without a user", () => {
    const { rerender } = render(<WorkOrganizationView employees={[]} user={{ name: "Prince" }} />);
    const card = screen.getByTestId("organization-user-card");
    expect(card.textContent).toContain("Prince’s Shiba");
    expect(card.textContent).toContain("Prince - You");
    expect(card.textContent).toContain("Personal chief of staff");
    expect(card.textContent).toContain("Personal agents are private");

    rerender(<WorkOrganizationView employees={[]} />);
    expect(screen.getByRole("heading", { name: "Your workspace" })).toBeDefined();
    expect(screen.getByTestId("organization-user-card").textContent).toContain("Your Shiba");
  });

  it("shows a real empty state and the grouping footer", () => {
    render(<WorkOrganizationView employees={[]} />);
    expect(screen.getByTestId("organization-empty-state")).toBeDefined();
    expect(screen.getByText(/Lines show grouping and ownership, not access permissions\./)).toBeDefined();
  });

  it("groups workspace agents by employee role with real counts", () => {
    const employees: OrganizationEmployee[] = [
      { id: "emp-1", name: "Engineer A", role: "Engineer", config: { roleTemplateId: "engineering" } },
      { id: "emp-2", name: "Engineer B", role: "Engineer", config: { roleTemplateId: "engineering" } },
      { id: "emp-3", name: "Researcher", role: "Researcher", config: { roleTemplateId: "research" } },
    ];
    render(<WorkOrganizationView employees={employees} />);
    expect(screen.getByRole("heading", { name: "Engineering (2)" })).toBeDefined();
    expect(screen.getByRole("heading", { name: "Research (1)" })).toBeDefined();
  });

  it("opens the chief, hire flow and outputs only when callbacks are provided", () => {
    const onOpenChief = vi.fn();
    const onHireEmployee = vi.fn();
    const onOpenOutputs = vi.fn();
    render(<WorkOrganizationView employees={[]} onOpenChief={onOpenChief} onHireEmployee={onHireEmployee} onOpenOutputs={onOpenOutputs} />);
    fireEvent.click(screen.getByRole("button", { name: "Open conversation" }));
    // An empty roster shows a single Hire employee button, in the empty state.
    expect(screen.getAllByRole("button", { name: "Hire employee" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Hire employee" }));
    fireEvent.click(screen.getByRole("button", { name: "Outputs & handoffs" }));
    expect(onOpenChief).toHaveBeenCalledOnce();
    expect(onHireEmployee).toHaveBeenCalledOnce();
    expect(onOpenOutputs).toHaveBeenCalledOnce();
  });

  it("hides optional organization controls when callbacks are absent", () => {
    render(<WorkOrganizationView employees={[]} />);
    expect(screen.queryByRole("button", { name: "Open conversation" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Hire employee" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Outputs & handoffs" })).toBeNull();
  });

  it("uses no department or manager wording", () => {
    const { container } = render(<WorkOrganizationView employees={[]} />);
    expect(container.textContent?.toLowerCase()).not.toMatch(/department|manager/);
  });

  it("opens the approvals queue in-app only when navigation is provided", () => {
    const onOpenApprovals = vi.fn();
    const { unmount } = render(<WorkOrganizationView employees={[]} onOpenApprovals={onOpenApprovals} />);
    fireEvent.click(screen.getByRole("button", { name: "Review human decisions" }));
    expect(onOpenApprovals).toHaveBeenCalledOnce();
    unmount();
    render(<WorkOrganizationView employees={[]} />);
    expect(screen.queryByRole("button", { name: "Review human decisions" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Review human decisions" })).toBeNull();
  });

  it("renders workspace agents with mascots, role and task counts, and opens on click", () => {
    const employees: OrganizationEmployee[] = [
      { id: "emp-1", name: "Engineering bot", role: "Software Engineer", openTaskCount: 3 },
      { id: "emp-2", name: "Research assistant", role: "Researcher", openTasks: 1 },
      {
        id: "emp-3",
        name: "",
        role: "Product",
        slug: "product-bot",
        config: { name: "Product bot" },
      },
    ];
    const onOpen = vi.fn();
    render(<WorkOrganizationView employees={employees} onOpen={onOpen} />);

    expect(screen.getByRole("list", { name: "Workspace agents" })).toBeDefined();
    expect(screen.getByText("Workspace agents (3)")).toBeDefined();
    expect(screen.getByRole("list", { name: "Member chiefs of staff" }).children).toHaveLength(1);
    expect(screen.queryByTestId("organization-empty-state")).toBeNull();
    expect(screen.getByTestId("avatar-emp-1")).toBeDefined();
    expect(screen.getByTestId("avatar-product-bot")).toBeDefined();
    expect(screen.getByText("3 tasks")).toBeDefined();
    expect(screen.getByText("1 task")).toBeDefined();
    expect(screen.getByText("Product bot")).toBeDefined();

    fireEvent.click(screen.getByTestId("employee-card-emp-1"));
    expect(onOpen).toHaveBeenCalledWith("emp-1");
  });
});
