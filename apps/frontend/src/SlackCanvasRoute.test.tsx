// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardContent } from "./routes/$";

const dashboard = vi.hoisted(() => vi.fn());
const canvas = vi.hoisted(() => vi.fn());
const verification = vi.hoisted(() => vi.fn());
const auth = vi.hoisted(() => vi.fn());
vi.mock("./app", () => ({ App: () => { dashboard(); return <main>Dashboard chat</main>; } }));
vi.mock("./components/SlackRunCanvas", () => ({
  SlackRunCanvas: (props: { search: string }) => { canvas(props); return <main>Read-only Slack canvas</main>; },
}));
vi.mock("./components/BootstrapVerificationPanel", () => ({
  BootstrapVerificationCallback: () => { verification(); return <main>Confirm account verification</main>; },
}));

vi.mock("./components/AuthScreen", () => ({
  AuthScreen: (props: { onSignedIn: () => void }) => {
    auth(props);
    return <button type="button" onClick={props.onSignedIn}>Password account form</button>;
  },
}));

afterEach(() => {
  cleanup();
  dashboard.mockClear();
  canvas.mockClear();
  verification.mockClear();
  auth.mockClear();
  vi.restoreAllMocks();
});

describe("Slack canvas route", () => {
  it.each(["/slack-canvas", "/slack-canvas/"])("bypasses the main chat application for %s", (pathname) => {
    render(<DashboardContent pathname={pathname} search="?origin=source&approval=approval" />);
    expect(screen.getByText("Read-only Slack canvas")).toBeTruthy();
    expect(canvas).toHaveBeenCalledWith({ search: "?origin=source&approval=approval" });
    expect(dashboard).not.toHaveBeenCalled();
  });

  it.each(["/auth/forgot", "/auth/forgot/", "/auth/reset", "/auth/reset/"])("shows the password form before dashboard session initialization at %s", (pathname) => {
    const navigate = vi.spyOn(window.location, "assign").mockImplementation(() => {});
    render(<DashboardContent pathname={pathname} search="?token=reset-test-token" />);
    expect(screen.getByRole("button", { name: "Password account form" })).toBeTruthy();
    expect(auth).toHaveBeenCalledOnce();
    expect(dashboard).not.toHaveBeenCalled();
    expect(canvas).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Password account form" }));
    expect(navigate).toHaveBeenCalledWith("/app/");
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
