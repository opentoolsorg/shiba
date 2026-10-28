// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { RunDeliverables } from "./RunDeliverables";

afterEach(cleanup);
const report = { path: "research/report.md", mediaType: "text/markdown", bytes: 128, sha256: "ab".repeat(32) };

describe("run deliverables", () => {
  it("keeps old runs without requested or captured files unchanged", () => {
    const { container } = render(<RunDeliverables runId="old" status="completed" />);
    expect(container.firstChild).toBeNull();
  });

  it("shows requested files while work is pending without inventing a download", () => {
    render(<RunDeliverables runId="run" status="running" expected={[report.path]} />);
    expect(screen.getByText(report.path)).toBeTruthy();
    expect(screen.getByText("Awaiting captured file")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("preserves the owning session and exact artifact index when downloading", () => {
    render(<RunDeliverables runId="agent-tool:one/two" sessionId="session & one" status="completed"
      expected={[report.path, "research/sources.json"]}
      deliverables={[{ ...report, path: "research/sources.json", mediaType: "application/json" }, report]} />);
    expect(screen.getByRole("link", { name: "Download research/report.md" }).getAttribute("href"))
      .toBe("/api/runs/agent-tool%3Aone%2Ftwo/deliverables/1?session=session+%26+one");
    expect(screen.getByRole("link", { name: "Download research/report.md" }).getAttribute("download")).toBe("report.md");
    expect(screen.getAllByText(`SHA-256: ${report.sha256}`)).toHaveLength(2);
    expect(screen.getByText(/Review their content/)).toBeTruthy();
  });

  it.each([undefined, "default"])("omits the session query for the default owner (%s)", (sessionId) => {
    render(<RunDeliverables runId="one" sessionId={sessionId} status="completed" deliverables={[report]} />);
    expect(screen.getByRole("link").getAttribute("href")).toBe("/api/runs/one/deliverables/0");
  });

  it.each(["error", "cancelled", "unknown", "completed"] as const)("does not call missing files captured on %s runs", (status) => {
    render(<RunDeliverables runId="run" status={status} expected={[report.path]} />);
    expect(screen.getByText("Not captured")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("shows a partial manifest without giving an absent output another file's link", () => {
    render(<RunDeliverables runId="one" status="error" expected={["research/missing.md", report.path]} deliverables={[report]} />);
    expect(screen.getByText("Not captured")).toBeTruthy();
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByRole("link").getAttribute("href")).toBe("/api/runs/one/deliverables/0");
  });
});
