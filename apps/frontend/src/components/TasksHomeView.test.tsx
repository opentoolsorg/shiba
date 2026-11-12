// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TasksHomeView } from "./TasksHomeView";
vi.mock("../live-status", () => ({useSetupStatus: () => ({state: {kind: "loading"}, reload: vi.fn(), inFlight: false})}));
afterEach(cleanup);
function show(overrides: Partial<React.ComponentProps<typeof TasksHomeView>> = {}) {
  return render(<TasksHomeView task="Fix the bug" onTaskChange={vi.fn()} agents={[]} selectedAgentId="" onAgentChange={vi.fn()} repoUrl="owner/repo" onRepoUrlChange={vi.fn()} runs={[]} approvals={[]} route={{runTarget: "local"}} onSubmit={vi.fn()} {...overrides} />);
}
describe("task handoff", () => {
  it("announces backend rejection or early validation notices next to handoff", () => {
    show({submitNotice: "Run could not be queued: Repository access denied"});
    expect(screen.getByText("Run could not be queued: Repository access denied").getAttribute("role")).toBe("status");
  });
  it("offers built-in Shiba even without custom agents and accepts shorthand", async () => {
    const submit = vi.fn(); show({onSubmit: submit});
    expect((screen.getByRole("combobox", {name: "Choose an agent"}) as HTMLSelectElement).disabled).toBe(false);
    expect(screen.getByRole("option", {name: "Shiba"})).toBeTruthy();
    fireEvent.submit(screen.getByRole("form", {name: "Hand off work"}));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit.mock.calls[0]?.[1]).toBe("");
  });
  it("keeps invalid repository errors beside the composer", () => {
    const submit = vi.fn(); show({repoUrl: "https://evil.com/a/b", onSubmit: submit});
    fireEvent.submit(screen.getByRole("form", {name: "Hand off work"}));
    expect(screen.getByRole("alert").textContent).toContain("owner/repo");
    expect(screen.getByRole("combobox", {name: "GitHub repository"}).getAttribute("aria-invalid")).toBe("true");
    expect(submit).not.toHaveBeenCalled();
  });
  it("locks duplicate submits until the handoff finishes", async () => {
    let finish!: () => void;
    const submit = vi.fn(() => new Promise<void>((resolve) => {finish = resolve;})); show({onSubmit: submit});
    const form = screen.getByRole("form", {name: "Hand off work"});
    fireEvent.submit(form); fireEvent.submit(form);
    expect(submit).toHaveBeenCalledTimes(1);
    finish(); await waitFor(() => expect(form.getAttribute("aria-busy")).toBe("false"));
  });
  it("blocks cloud handoff until setup is checked", () => {
    const submit = vi.fn(); show({route: {runTarget: "sandbox"}, onSubmit: submit});
    fireEvent.submit(screen.getByRole("form", {name: "Hand off work"}));
    expect(submit).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain("Checking model setup");
  });
});
