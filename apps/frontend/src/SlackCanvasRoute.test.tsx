// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardContent } from "./routes/$";

const dashboard = vi.hoisted(() => vi.fn());
const canvas = vi.hoisted(() => vi.fn());
vi.mock("./app", () => ({ App: () => { dashboard(); return <main>Dashboard chat</main>; } }));
vi.mock("./components/SlackRunCanvas", () => ({
  SlackRunCanvas: (props: { search: string }) => { canvas(props); return <main>Read-only Slack canvas</main>; },
}));

afterEach(() => {
  cleanup();
  dashboard.mockClear();
  canvas.mockClear();
});

describe("Slack canvas route", () => {
  it.each(["/slack-canvas", "/slack-canvas/"])("bypasses the main chat application for %s", (pathname) => {
    render(<DashboardContent pathname={pathname} search="?origin=source&approval=approval" />);
    expect(screen.getByText("Read-only Slack canvas")).toBeTruthy();
    expect(canvas).toHaveBeenCalledWith({ search: "?origin=source&approval=approval" });
    expect(dashboard).not.toHaveBeenCalled();
  });

  it("preserves the existing dashboard for other routes", () => {
    render(<DashboardContent pathname="/threads/" search="" />);
    expect(screen.getByText("Dashboard chat")).toBeTruthy();
    expect(canvas).not.toHaveBeenCalled();
  });
});
