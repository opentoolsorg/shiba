// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { UIMessage } from "ai";
import { VideoArtifactPlayer } from "./VideoArtifactPlayer";
import { StepTimeline } from "./StepTimeline";
import { RunDeliverables } from "./RunDeliverables";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const source = "/api/files/video-1/download";

describe("video artifacts", () => {
  it("renders an authenticated video with native controls and no autoplay", () => {
    const { container } = render(<VideoArtifactPlayer src={source} />);
    const video = container.querySelector("video");
    expect(video?.getAttribute("src")).toBe(source);
    expect(video?.hasAttribute("controls")).toBe(true);
    expect(video?.getAttribute("preload")).toBe("metadata");
    expect(video?.hasAttribute("autoplay")).toBe(false);
    expect(screen.getByRole("link", { name: "Download Generated video" }).getAttribute("href")).toBe(source);
  });

  it.each(["https://provider.example/video.mp4", "//provider.example/video.mp4", "javascript:alert(1)", "/api/\\evil/video.mp4"])("rejects a nonlocal source %s", (src) => {
    const { container } = render(<VideoArtifactPlayer src={src} />);
    expect(container.querySelector("video")).toBeNull();
  });

  it("renders the completed video tool result in chat", () => {
    const messages = [{ id: "message-1", role: "assistant", parts: [{
      type: "tool-generate_video", toolCallId: "call-1", state: "output-available", input: {},
      output: { ok: true, downloadPath: source, mime: "video/mp4", artifactId: "video-1" },
    }] }] as UIMessage[];
    const { container } = render(<StepTimeline messages={messages} isStreaming={false} pendingApprovals={[]} decisions={{}} onDecideApproval={() => {}} />);
    expect(container.querySelector("video")?.getAttribute("src")).toBe(source);
    expect(screen.queryByText("Output")).toBeNull();
  });

  it("leaves failed tool messages readable without a player", () => {
    const messages = [{ id: "message-1", role: "assistant", parts: [{
      type: "tool-generate_video", toolCallId: "call-1", state: "output-available", input: {},
      output: { ok: false, error: "Video generation timed out." },
    }] }] as UIMessage[];
    const { container } = render(<StepTimeline messages={messages} isStreaming={false} pendingApprovals={[]} decisions={{}} onDecideApproval={() => {}} />);
    expect(container.querySelector("video")).toBeNull();
    expect(screen.getByText(/Video generation timed out/)).toBeTruthy();
  });

  it("renders a task MP4 with its owning run and session", () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ versions: [] })));
    const { container } = render(<RunDeliverables runId="run-1" sessionId="session-1" status="completed" deliverables={[{
      path: "outputs/video.mp4", mediaType: "video/mp4", bytes: 128, sha256: "ab".repeat(32),
    }]} />);
    expect(container.querySelector("video")?.getAttribute("src"))
      .toBe("/api/runs/run-1/deliverables/0?session=session-1");
  });
});
