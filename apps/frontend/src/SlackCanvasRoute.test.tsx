// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardContent } from "./routes/$";

const dashboard = vi.hoisted(() => vi.fn());
const canvas = vi.hoisted(() => vi.fn());
const verification = vi.hoisted(() => vi.fn());
vi.mock("./app", () => ({ App: () => { dashboard(); return <main>Dashboard chat</main>; } }));
vi.mock("./components/SlackRunCanvas", () => ({
  SlackRunCanvas: (props: { search: string }) => { canvas(props); return <main>Read-only Slack canvas</main>; },
}));
vi.mock("./components/BootstrapVerificationPanel", () => ({
  BootstrapVerificationCallback: () => { verification(); return <main>Confirm account verification</main>; },
}));

afterEach(() => {
  cleanup();
  dashboard.mockClear();
  canvas.mockClear();
  verification.mockClear();
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

  it.each(["/app", "/app/"])("opens the bootstrap verification callback without private dashboard initialization at %s", (pathname) => {
    render(<DashboardContent pathname={pathname} search="?verify=bootstrap" />);
    expect(screen.getByText("Confirm account verification")).toBeTruthy();
    expect(verification).toHaveBeenCalledOnce();
    expect(dashboard).not.toHaveBeenCalled();
    expect(canvas).not.toHaveBeenCalled();
  });

  it("does not select the verification callback from unrelated paths or query values", () => {
    const view = render(<DashboardContent pathname="/threads/" search="?verify=bootstrap" />);
    expect(screen.getByText("Dashboard chat")).toBeTruthy();
    view.rerender(<DashboardContent pathname="/app/" search="?verify=unrecognized" />);
    expect(screen.getByText("Dashboard chat")).toBeTruthy();
    expect(verification).not.toHaveBeenCalled();
  });
});
