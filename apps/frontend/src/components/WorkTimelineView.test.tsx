// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkTimelineView } from "./WorkTimelineView";

// Wednesday Nov 5 2026: today's week starts Sun Nov 1; the grid starts six weeks earlier on Sun Sep 20.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 5, 12));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const DAY_W = 24;

function bar(name: string): HTMLElement {
  return screen.getByRole("button", { name });
}

describe("WorkTimelineView", () => {
  it("keeps impossible calendar dates undated instead of drawing a fabricated date", () => {
    render(<WorkTimelineView tasks={[{ id: "invalid", title: "Invalid date", status: "pending", startDate: "2026-02-30" }]} onOpen={vi.fn()} />);
    expect(screen.getByText("No dates recorded")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Invalid date, / })).toBeNull();
    expect(screen.getByRole("button", { name: "Invalid date Pending" })).toBeTruthy();
  });
  it("renders the empty state when there are no tasks", () => {
    render(<WorkTimelineView tasks={[]} onOpen={vi.fn()} />);
    expect(screen.getByText("No tasks yet")).toBeTruthy();
    expect(screen.getByText("Add a task above. It lands in Todo.")).toBeTruthy();
    expect(screen.queryByTestId("timeline-scroller")).toBeNull();
  });

  it("renders custom empty state text when provided", () => {
    render(
      <WorkTimelineView
        tasks={[]}
        onOpen={vi.fn()}
        emptyTitle="Nothing here"
        emptyDescription="Nothing dated yet."
      />,
    );
    expect(screen.getByText("Nothing here")).toBeTruthy();
    expect(screen.getByText("Nothing dated yet.")).toBeTruthy();
  });

  it("draws week-start labels, weekday letters and a Today pill scrolled into view", () => {
    render(
      <WorkTimelineView
        tasks={[{ id: "t1", title: "Undated", status: "pending" }]}
        onOpen={vi.fn()}
      />,
    );
    for (const label of ["Sep 20", "Oct 25", "Nov 1", "Nov 8", "Nov 15", "Nov 22", "Nov 29"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getAllByText("W").length).toBeGreaterThanOrEqual(5);
    const today = screen.getByTestId("timeline-today");
    expect(today.textContent).toBe("Today");
    expect(today.style.left).toBe(`${46 * DAY_W + DAY_W / 2}px`);
    // Two lead weeks before today's week (Oct 18) sit at the left edge: 4 weeks past the grid start.
    expect(screen.getByTestId("timeline-scroller").scrollLeft).toBe(4 * 7 * DAY_W);
  });

  it("positions dated tasks as bars by date and opens them on click", () => {
    const onOpen = vi.fn();
    render(
      <WorkTimelineView
        tasks={[
          {
            id: "t1",
            title: "Ship timeline",
            status: "running",
            startDate: "2026-11-03",
            endDate: "2026-11-06",
          },
        ]}
        onOpen={onOpen}
      />,
    );
    const el = bar("Ship timeline, Nov 3 – Nov 6, Running");
    expect(el.style.left).toBe(`${44 * DAY_W + 2}px`);
    expect(el.style.width).toBe(`${4 * DAY_W - 4}px`);
    expect(el.className).toContain("bg-amber-500");
    fireEvent.click(el);
    expect(onOpen).toHaveBeenCalledWith("t1");
  });

  it("treats a single date as a one-day bar and orders reversed dates", () => {
    render(
      <WorkTimelineView
        tasks={[
          { id: "a", title: "Due only", status: "completed", endDate: "2026-11-10T09:00:00Z" },
          {
            id: "b",
            title: "Reversed",
            status: "error",
            startDate: "2026-11-12",
            endDate: "2026-11-10",
          },
        ]}
        onOpen={vi.fn()}
      />,
    );
    const due = bar("Due only, Nov 10, Completed");
    expect(due.style.width).toBe(`${DAY_W - 4}px`);
    expect(due.className).toContain("bg-[var(--success)]");
    const reversed = bar("Reversed, Nov 10 – Nov 12, Error");
    expect(reversed.style.left).toBe(`${51 * DAY_W + 2}px`);
    expect(reversed.className).toContain("bg-[var(--destructive)]");
  });

  it("shows only the row for undated tasks, with status, open action and assignee slot", () => {
    const onOpen = vi.fn();
    render(
      <WorkTimelineView
        tasks={[
          { id: "u1", title: "Investigate latency", status: "pr-open" },
          { id: "u2", title: "Write docs", status: "pending", assigneeName: "Prince Pal" },
          { id: "u3", title: "Bad date", status: "pending", startDate: "soon" },
        ]}
        onOpen={onOpen}
      />,
    );
    const rows = within(screen.getByRole("list", { name: "Timeline tasks" })).getAllByRole(
      "listitem",
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(within(row).getAllByRole("button")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Investigate latency PR linked" }));
    expect(onOpen).toHaveBeenCalledWith("u1");
    expect(screen.getAllByRole("img", { name: "Unassigned" })).toHaveLength(2);
    expect(screen.getByRole("img", { name: "Assigned to Prince Pal" }).textContent).toBe("PP");
  });

  it("extends the grid backwards to include an older dated task", () => {
    render(
      <WorkTimelineView
        tasks={[
          {
            id: "old",
            title: "Old work",
            status: "completed",
            startDate: "2026-08-04",
            endDate: "2026-08-05",
          },
        ]}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByText("Aug 2")).toBeTruthy();
    expect(bar("Old work, Aug 4 – Aug 5, Completed").style.left).toBe(`${2 * DAY_W + 2}px`);
    // Grid now starts Aug 2 (13 weeks before today's week); the view still opens two weeks before today.
    expect(screen.getByTestId("timeline-scroller").scrollLeft).toBe(11 * 7 * DAY_W);
  });

  it("offers Review only for rows waiting on approval", () => {
    const onReview = vi.fn();
    render(
      <WorkTimelineView
        tasks={[
          { id: "w1", title: "Deploy", status: "waiting-approval" },
          { id: "r1", title: "Build", status: "running" },
        ]}
        onOpen={vi.fn()}
        onReview={onReview}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Review Deploy" }));
    expect(onReview).toHaveBeenCalledWith("w1");
    expect(screen.queryByRole("button", { name: "Review Build" })).toBeNull();
  });
});
