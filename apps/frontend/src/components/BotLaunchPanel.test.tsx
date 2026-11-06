// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BotLaunchPanel } from "./BotLaunchPanel";
import { BotReadinessClient, type BotReadiness } from "../bot-readiness";

afterEach(cleanup);

const ready: BotReadiness = {
  ready: true,
  target: { kind: "repository", repoUrl: "https://github.com/example/repo" },
  harness: "opencode",
  model: "google/gemini-3.5-flash-lite",
  connectionId: null,
  synthetic: false,
  problems: [],
};

describe("BotLaunchPanel", () => {
  it("shows the default target and that approval is still required", () => {
    render(<BotLaunchPanel botName="Scout" state={{ status: "ready", readiness: ready }} onFix={vi.fn()} onRecheck={vi.fn()} />);
    expect(screen.getByTestId("bot-launch-target").textContent).toContain("https://github.com/example/repo");
    expect(screen.getByText(/Nothing runs until you approve the run card/)).toBeTruthy();
    expect(screen.queryByTestId("bot-synthetic-badge")).toBeNull();
  });

  it("lists preflight problems with fix links that route to the fixing view", () => {
    const onFix = vi.fn();
    const blocked: BotReadiness = {
      ...ready,
      ready: false,
      problems: [{ id: "gateway.token", severity: "error", message: "AI Gateway is not configured (AI_GATEWAY_TOKEN is unset).", fix: { label: "Connect a model or add the gateway token", view: "providers" } }],
    };
    render(<BotLaunchPanel botName="Scout" state={{ status: "ready", readiness: blocked }} onFix={onFix} onRecheck={vi.fn()} />);
    expect(screen.getByTestId("bot-launch-panel").getAttribute("data-ready")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Connect a model or add the gateway token" }));
    expect(onFix).toHaveBeenCalledWith("providers");
    expect(screen.getByText(/refused before approval/)).toBeTruthy();
  });

  it("describes an artifact-workspace bot and labels synthetic deployments", () => {
    const artifact: BotReadiness = { ...ready, synthetic: true, target: { kind: "artifact-workspace", expectedDeliverables: ["deliverables/brief.md"] } };
    render(<BotLaunchPanel botName="Writer" state={{ status: "ready", readiness: artifact }} onFix={vi.fn()} onRecheck={vi.fn()} />);
    expect(screen.getByTestId("bot-launch-target").textContent).toContain("artifact workspace (no repository)");
    expect(screen.getByTestId("bot-synthetic-badge")).toBeTruthy();
  });

  it("offers a recheck when the readiness request fails", () => {
    const onRecheck = vi.fn();
    render(<BotLaunchPanel botName="Scout" state={{ status: "error", error: "Bot readiness could not be checked (503)." }} onFix={vi.fn()} onRecheck={onRecheck} />);
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(onRecheck).toHaveBeenCalledOnce();
  });
});

describe("BotReadinessClient.parse", () => {
  it("drops fix links to views the dashboard cannot open", () => {
    const parsed = BotReadinessClient.parse({
      ...ready,
      problems: [
        { id: "a", severity: "error", message: "m", fix: { label: "ok", view: "providers" } },
        { id: "b", severity: "error", message: "m", fix: { label: "bad", view: "javascript:alert(1)" } },
      ],
    });
    expect(parsed?.problems.map((problem) => problem.id)).toEqual(["a"]);
  });

  it("rejects malformed reports", () => {
    expect(BotReadinessClient.parse({ ready: true, target: { kind: "connected-app" }, problems: [] })).toBeNull();
    expect(BotReadinessClient.parse(null)).toBeNull();
  });
});
