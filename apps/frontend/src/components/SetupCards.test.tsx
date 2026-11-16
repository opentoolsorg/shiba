// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ModelRouteCard, SlackSetupCard, ToolSetupList } from "./SetupCards";
import { TasksHomeView } from "./TasksHomeView";
import { taskReadiness } from "../task-readiness";
import type { SetupStatus } from "../live-status";

const mockSetup = vi.hoisted(() => ({ state: { kind: "loading" } as unknown }));
vi.mock("../live-status", () => ({ useSetupStatus: () => ({ state: mockSetup.state, reload: vi.fn(), inFlight: false }) }));
afterEach(cleanup);

const notReady = { ready: false, via: null, fix: { kind: "connect-provider", label: "Connect ChatGPT or Claude", href: "/settings/?section=providers" } } as const;
const roles = [{ role: "fixer", harness: "codex", model: "m", connectionId: null, ok: true }];
const data = (modelRoute: SetupStatus["modelRoute"]) => ({ kind: "data", data: { models: { harness: "codex", coding: "m", orchestrator: "", roles: [] }, doctor: { ok: true, checkedAt: 0, findings: [], roles }, modelRoute } });

function home() {
  return <TasksHomeView task="Fix it" onTaskChange={vi.fn()} agents={[]} selectedAgentId="" onAgentChange={vi.fn()} repoUrl="owner/repo" onRepoUrlChange={vi.fn()} runs={[]} approvals={[]} onSubmit={vi.fn()} onOpenProviders={onOpenProviders} />;
}
const onOpenProviders = vi.fn();

describe("model route card", () => {
  it("shows the card, disables Send, and Connect opens Providers", () => {
    mockSetup.state = data(notReady);
    render(home());
    expect(screen.getAllByText("Connect ChatGPT or Claude to run tasks").length).toBeGreaterThan(0);
    expect((screen.getByRole("button", { name: "Send task" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Send task" }).getAttribute("title")).toContain("Connect ChatGPT or Claude");
    fireEvent.click(screen.getAllByRole("button", { name: "Connect" })[0]!);
    expect(onOpenProviders).toHaveBeenCalled();
  });

  it("flips to ready once a provider is linked", () => {
    mockSetup.state = data(notReady);
    const view = render(home());
    expect((screen.getByRole("button", { name: "Send task" }) as HTMLButtonElement).disabled).toBe(true);
    mockSetup.state = data({ ready: true, via: "personal-provider", fix: null });
    view.rerender(home());
    expect(screen.queryByTestId("model-route-card")).toBeNull();
    expect((screen.getByRole("button", { name: "Send task" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("falls back to a link when no handler is given", () => {
    render(<ModelRouteCard modelRoute={notReady} />);
    expect(screen.getByRole("link", { name: "Connect" }).getAttribute("href")).toBe("/settings/?section=providers");
  });

  it("blocks task readiness only on the sandbox target", () => {
    const state = data(notReady) as never;
    expect(taskReadiness(state, {}).blocked).toBe(true);
    expect(taskReadiness(state, { runTarget: "local" }).blocked).toBe(false);
  });
});

describe("slack and tool setup cards", () => {
  it("shows three Slack steps and the docs link without an alert", () => {
    render(<SlackSetupCard />);
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByRole("link", { name: "Slack setup guide" }).getAttribute("href")).toBe("/docs/slack-setup/");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("marks a tool missing its key as Needs setup with the env name", () => {
    render(<ToolSetupList tools={[{ id: "web_search", label: "Web search", ready: false, env: "WEB_SEARCH_API_KEY" }, { id: "browser", label: "Browser", ready: true, env: "BROWSER" }]} />);
    expect(screen.getByText("Needs setup · WEB_SEARCH_API_KEY")).toBeTruthy();
    expect(screen.getByText("Ready")).toBeTruthy();
  });
});
