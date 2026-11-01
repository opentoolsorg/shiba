// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConversationRoomPresence, RemoteAgentStream } from "./ConversationRoomPresence";

describe("conversation room status", () => {
  it("shows active viewers, typing, and another viewer's live agent text", () => {
    render(
      <>
        <ConversationRoomPresence
          status="connected"
          viewerId="self"
          viewers={[
            { viewerId: "self", joinedAt: 1, typing: false },
            { viewerId: "other", joinedAt: 2, typing: true },
          ]}
        />
        <RemoteAgentStream stream={{ streamId: "stream-1", viewerId: "other", text: "Working through it" }} />
      </>,
    );

    expect(screen.getAllByRole("status")[0]?.textContent).toContain("2 viewers here");
    expect(screen.getAllByRole("status")[0]?.textContent).toContain("Another viewer is typing");
    expect(screen.getByRole("status", { name: "Live agent response from another viewer" }).textContent)
      .toContain("Working through it");
  });
});
