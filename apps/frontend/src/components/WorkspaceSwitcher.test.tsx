// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { TeamWorkspaceSummary } from "@shiba/shared";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

afterEach(cleanup);
const workspace: TeamWorkspaceSummary = {
  workspaceId: `ws_${"a".repeat(24)}`,
  name: "Acme",
  version: 1,
  createdAt: 1,
  membership: {
    workspaceId: `ws_${"a".repeat(24)}`,
    userId: "a@example.com",
    role: "member",
    version: 1,
    joinedAt: 1,
  },
};
it("offers personal and verified team choices with separate management", () => {
  const select = vi.fn(),
    manage = vi.fn();
  render(
    <WorkspaceSwitcher
      workspaces={[workspace]}
      selectedWorkspaceId={workspace.workspaceId}
      onSelect={select}
      onManage={manage}
    />,
  );
  expect(screen.getByRole("option", { name: "Acme · Shared · member" })).toBeTruthy();
  expect(screen.getByRole("option", { name: "Personal · Private" })).toBeTruthy();
  expect(screen.getByText("Changes apply across the app.")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Switch workspace"), { target: { value: "" } });
  expect(select).toHaveBeenCalledWith("");
  fireEvent.click(screen.getByRole("button", { name: "Manage team workspaces" }));
  expect(manage).toHaveBeenCalledTimes(1);
});
it("disables switching during membership validation without silently choosing personal", () => {
  render(
    <WorkspaceSwitcher
      workspaces={[]}
      loading
      selectedWorkspaceId={workspace.workspaceId}
      onSelect={vi.fn()}
      onManage={vi.fn()}
    />,
  );
  const selector = screen.getByLabelText("Switch workspace") as HTMLSelectElement;
  expect(selector.disabled).toBe(true);
  expect(selector.value).toBe(workspace.workspaceId);
  expect(screen.getByRole("option", { name: "Checking selected workspace…" })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain("Checking memberships");
});
it("uses distinct labels when desktop and mobile switches are both mounted", () => {
  render(
    <>
      <WorkspaceSwitcher
        workspaces={[]}
        selectedWorkspaceId=""
        onSelect={vi.fn()}
        onManage={vi.fn()}
      />
      <WorkspaceSwitcher
        workspaces={[]}
        selectedWorkspaceId=""
        onSelect={vi.fn()}
        onManage={vi.fn()}
      />
    </>,
  );
  const selectors = screen.getAllByLabelText("Switch workspace");
  expect(selectors).toHaveLength(2);
  expect(selectors[0]?.id).not.toBe(selectors[1]?.id);
});
