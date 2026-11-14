// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RunThreadPanel } from "./RunThreadPanel";
import type { RetainedRun } from "../types";

const run: RetainedRun = {
  runId: "run_tabs",
  task: "Demo",
  repoUrl: "https://github.com/o/r",
  status: "completed",
  generation: 1,
  createdAt: 1,
  updatedAt: 2,
  diff: "diff --git a/README.md b/README.md",
} as RetainedRun;

describe("RunThreadPanel tabs", () => {
  it("switches between timeline, diff, and proof tabs", () => {
    let tab: "conversation" | "timeline" | "diff" | "proof" = "conversation";
    const { rerender } = render(
      <RunThreadPanel
        run={run}
        tab={tab}
        sessionId="session_1"
        proof={{ screenshotUrl: null, browserE2eManifestUrl: null, previewUrl: null, testOutputTail: "tests passed", pullUrl: null }}
        onTabChange={(next) => { tab = next; }}
        conversation={<p>Chat</p>}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Diff" }));
    rerender(
      <RunThreadPanel run={run} tab="diff" sessionId="session_1" proof={null} onTabChange={() => {}} conversation={<p>Chat</p>} />,
    );
    expect(screen.getByText(/diff --git/)).toBeTruthy();
    rerender(
      <RunThreadPanel run={run} tab="proof" sessionId="session_1" proof={{ screenshotUrl: null, browserE2eManifestUrl: null, previewUrl: null, testOutputTail: "tests passed", pullUrl: null }} onTabChange={() => {}} conversation={<p>Chat</p>} />,
    );
    expect(screen.getByText("tests passed")).toBeTruthy();
  });
});