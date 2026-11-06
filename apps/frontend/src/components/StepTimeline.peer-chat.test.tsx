// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StepTimeline } from "./StepTimeline";

afterEach(cleanup);

describe("room peer chat attribution", () => {
  it.each([true, false])("labels peer chat %s without creating action controls", (peerChat) => {
    render(<StepTimeline
      messages={[{ id: "room-note", role: "user", metadata: { shibaPeerChat: peerChat }, parts: [{ type: "text", text: "A note to another viewer" }] }]}
      isStreaming={false}
      pendingApprovals={[]}
      decisions={{}}
      onDecideApproval={vi.fn()}
    />);
    expect(screen.getByText(peerChat ? "Peer chat" : "You")).toBeTruthy();
    expect(screen.getByText("A note to another viewer")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
