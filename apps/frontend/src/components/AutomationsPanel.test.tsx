// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AutomationsPanel } from "./AutomationsView";

afterEach(cleanup);

describe("AutomationsPanel", () => {
  it("renders navigation items, deployed automations, and handles selection", () => {
    const onSelect = vi.fn();
    const onScopeChange = vi.fn();
    const onNewAutomation = vi.fn();

    render(
      <AutomationsPanel
        scope="personal"
        onScopeChange={onScopeChange}
        active="automations"
        onSelect={onSelect}
        automations={[
          {
            id: "nightly-lint",
            repoUrl: "https://github.com/acme/app",
            prompt: "Lint",
            enabled: true,
            triggers: [{ kind: "schedule" }],
          },
          {
            id: "custom-job",
            repoUrl: "https://github.com/acme/app",
            prompt: "Custom",
            enabled: false,
            triggers: [{ kind: "manual" }],
          },
        ]}
        onNewAutomation={onNewAutomation}
      />,
    );

    expect(screen.getByText("Automations")).toBeTruthy();
    expect(screen.getByText("All automations")).toBeTruthy();
    expect(screen.getByText("Recipes")).toBeTruthy();
    expect(screen.getByText("Triggers")).toBeTruthy();
    expect(screen.getByText("Nightly lint fixes")).toBeTruthy();
    expect(screen.getByText("custom-job")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Recipes" }));
    expect(onSelect).toHaveBeenCalledWith("recipes");

    fireEvent.click(screen.getByRole("button", { name: "New automation" }));
    expect(onNewAutomation).toHaveBeenCalledOnce();
  });
});
