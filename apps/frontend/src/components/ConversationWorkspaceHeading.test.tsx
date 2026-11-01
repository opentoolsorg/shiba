// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConversationWorkspaceHeading } from "./ConversationWorkspaceHeading";

describe("ConversationWorkspaceHeading", () => {
  it("labels app tools independently of stale repository or local runtime settings", () => {
    render(<ConversationWorkspaceHeading title="Research helper" mode="work" appToolsWork executionTargetKind="repository" runTarget="local" repoUrl="https://github.com/acme/ignored" artifactWorkspaceName="Ignored" machineName="dev-laptop" />);
    expect(screen.getByLabelText("Next task target: Connected app tools")).toBeTruthy();
    expect(screen.queryByText(/dev-laptop|acme\/ignored/)).toBeNull();
  });

  it("shows the selected repo and cloud execution target without inventing a connection state", () => {
    render(
      <ConversationWorkspaceHeading
        title="Current session"
        executionTargetKind="repository"
        runTarget="sandbox"
        repoUrl="https://github.com/acme/shiba.git"
        artifactWorkspaceName="My workspace"
      />,
    );

    expect(screen.getByRole("heading", { name: "Current session" })).toBeTruthy();
    expect(screen.getByLabelText("Next task target: Cloud sandbox, Repository, acme/shiba")).toBeTruthy();
  });

  it("labels an artifact workspace independently of the currently selected computer", () => {
    render(
      <ConversationWorkspaceHeading
        title="Research brief"
        executionTargetKind="artifact-workspace"
        runTarget="sandbox"
        repoUrl="https://github.com/acme/ignored"
        artifactWorkspaceName="Launch notes"
        machineName="laptop"
      />,
    );

    expect(screen.getByLabelText("Next task target: Cloud sandbox, Artifact workspace, Launch notes")).toBeTruthy();
  });

  it("identifies the paired local machine when local repository execution is selected", () => {
    render(
      <ConversationWorkspaceHeading
        title="Fix the bug"
        executionTargetKind="repository"
        runTarget="local"
        repoUrl="https://github.com/acme/shiba"
        artifactWorkspaceName="My workspace"
        machineName="dev-laptop"
      />,
    );

    expect(screen.getByLabelText("Next task target: Local computer, Repository, dev-laptop")).toBeTruthy();
  });
});
