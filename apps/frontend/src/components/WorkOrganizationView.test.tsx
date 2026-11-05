// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  WorkOrganizationView,
  type OrganizationEmployee,
} from "./WorkOrganizationView";

afterEach(() => {
  cleanup();
});

describe("WorkOrganizationView", () => {
  it("renders the user card at the top with default and custom values", () => {
    const { rerender } = render(<WorkOrganizationView employees={[]} />);

    expect(screen.getByTestId("organization-user-card")).toBeDefined();
    expect(screen.getByText("You")).toBeDefined();
    expect(screen.getByText("Workspace Owner")).toBeDefined();

    rerender(
      <WorkOrganizationView
        employees={[]}
        user={{ name: "Alice Wonderland", role: "Head of AI" }}
      />
    );

    expect(screen.getByText("Alice Wonderland")).toBeDefined();
    expect(screen.getByText("Head of AI")).toBeDefined();
    expect(screen.getByText("AW")).toBeDefined();
  });

  it("renders the muted empty state when no employees are present", () => {
    render(<WorkOrganizationView employees={[]} />);

    expect(screen.getByTestId("organization-empty-state")).toBeDefined();
    expect(screen.getByText("No AI employees yet")).toBeDefined();
    expect(
      screen.getByText("Custom agents and employee bots will appear here grouped by department.")
    ).toBeDefined();
  });

  it("renders employees grouped by department with avatar initial, name, role, and open tasks", () => {
    const employees: OrganizationEmployee[] = [
      {
        id: "emp-1",
        name: "Engineering bot",
        role: "Software Engineer",
        department: "Engineering",
        emoji: "🛠️",
        openTaskCount: 3,
        description: "Implement focused repository changes with tests.",
      },
      {
        id: "emp-2",
        name: "Marketing bot",
        role: "Growth Marketer",
        department: "Marketing",
        emoji: "📣",
        openTaskCount: 0,
        description: "Draft campaigns and briefs.",
      },
      {
        id: "emp-3",
        name: "Research assistant",
        role: "Researcher",
        // department omitted to test role inference
        openTasks: 1,
      },
    ];

    const onOpen = vi.fn();
    render(<WorkOrganizationView employees={employees} onOpen={onOpen} />);

    // Check department headers
    expect(screen.getByText("Engineering")).toBeDefined();
    expect(screen.getByText("Marketing")).toBeDefined();
    expect(screen.getByText("Research")).toBeDefined();

    // Check avatar initials
    expect(screen.getByText("EB")).toBeDefined();
    expect(screen.getByText("MB")).toBeDefined();
    expect(screen.getByText("RA")).toBeDefined();

    // Check emojis
    expect(screen.getByText("🛠️")).toBeDefined();
    expect(screen.getByText("📣")).toBeDefined();

    // Check open task count badges
    expect(screen.getByText("3 tasks")).toBeDefined();
    expect(screen.getByText("0 tasks")).toBeDefined();
    expect(screen.getByText("1 task")).toBeDefined();

    // Clicking an employee card triggers onOpen
    const card = screen.getByTestId("employee-card-emp-1");
    fireEvent.click(card);
    expect(onOpen).toHaveBeenCalledWith("emp-1");
  });

  it("supports employee template and custom agent config shapes", () => {
    const employees: OrganizationEmployee[] = [
      {
        id: "custom-1",
        name: "",
        role: "Product development",
        slug: "product-bot",
        config: {
          name: "Product bot",
          emoji: "🧩",
          instructions: "Define product specs",
        },
      },
    ];

    render(<WorkOrganizationView employees={employees} />);

    expect(screen.getByText("Product bot")).toBeDefined();
    expect(screen.getByText("Product development")).toBeDefined();
    expect(screen.getByText("🧩")).toBeDefined();
  });
});
