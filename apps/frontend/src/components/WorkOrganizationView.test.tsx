// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type OrganizationEmployee, WorkOrganizationView } from "./WorkOrganizationView";

vi.mock("./AgentAvatar", () => ({
  AgentAvatar: ({ id, name }: { id: string; name: string }) => (
    <span data-testid={`avatar-${id}`} role="img" aria-label={name} />
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

  it("shows a real empty state and the coordination footer", () => {
    render(<WorkOrganizationView employees={[]} />);
    expect(screen.getByTestId("organization-empty-state")).toBeDefined();
    expect(screen.getByText(/Lines show coordination, not access permissions\./)).toBeDefined();
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
