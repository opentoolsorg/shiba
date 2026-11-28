// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CHANNEL_CAPABILITY_MATRIX, ChannelMatrix, type ChannelSurfaceId } from "./ChannelMatrix";

afterEach(cleanup);

const SURFACES: ChannelSurfaceId[] = ["slack", "discord", "teams", "telegram", "gmail", "ios"];

describe("ChannelMatrix", () => {
  it("renders every surface row with a setup link and no fake live claims by default", () => {
    render(<ChannelMatrix />);
    const matrix = screen.getByTestId("channel-matrix");
    expect(screen.getByRole("heading", { name: "Channel capability matrix" })).toBeTruthy();
    for (const id of SURFACES) {
      const row = within(matrix).getByTestId(`channel-matrix-row-${id}`);
      expect(row).toBeTruthy();
      // Without a real deployment read, no row may claim to be live.
      expect(within(row).queryByText("Live")).toBeNull();
      const link = within(row).getByRole("link");
      expect(link.getAttribute("href")).toMatch(/^\/docs\//);
    }
  });

  it("marks unverifiable connections honestly instead of pretending live status", () => {
    render(<ChannelMatrix />);
    const slack = screen.getByTestId("channel-matrix-row-slack");
    expect(within(slack).getByText("Not verified here")).toBeTruthy();
    expect(within(slack).getByText("Implemented")).toBeTruthy();
  });

  it("shows Live only for surfaces with a real connected read", () => {
    render(<ChannelMatrix live={{ slack: "connected", discord: "disconnected", gmail: "checking" }} />);
    expect(within(screen.getByTestId("channel-matrix-row-slack")).getByText("Live")).toBeTruthy();
    expect(within(screen.getByTestId("channel-matrix-row-discord")).getByText("Not connected")).toBeTruthy();
    expect(within(screen.getByTestId("channel-matrix-row-gmail")).getByText("Checking…")).toBeTruthy();
    expect(within(screen.getByTestId("channel-matrix-row-teams")).getByText("Not verified here")).toBeTruthy();
  });

  it("states the real backend limitations for Teams, Telegram, Gmail, and iOS", () => {
    render(<ChannelMatrix />);
    const teams = screen.getByTestId("channel-matrix-row-teams");
    expect(within(teams).getAllByText("No").length).toBeGreaterThanOrEqual(2);
    expect(within(teams).getByText(/no message-history API/i)).toBeTruthy();
    expect(within(teams).queryByText("Planned")).toBeNull();

    const telegram = screen.getByTestId("channel-matrix-row-telegram");
    expect(within(telegram).getByText("Email / dashboard")).toBeTruthy();
    expect(within(telegram).getByText(/Bot API has no message history/i)).toBeTruthy();

    const gmail = screen.getByTestId("channel-matrix-row-gmail");
    expect(within(gmail).getByText("Partially implemented")).toBeTruthy();
    expect(within(gmail).getByText(/never decided over email/i)).toBeTruthy();

    const ios = screen.getByTestId("channel-matrix-row-ios");
    expect(within(ios).getByText("Queue only")).toBeTruthy();
    expect(within(ios).getByText(/native iOS app is planned/i)).toBeTruthy();
  });

  it("keeps the approval-first contract visible and links every setup guide", () => {
    render(<ChannelMatrix />);
    expect(screen.getByText(/nothing executes until a human approves it/i)).toBeTruthy();
    const hrefs = CHANNEL_CAPABILITY_MATRIX.map((entry) => entry.setupHref);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const entry of CHANNEL_CAPABILITY_MATRIX) {
      const row = screen.getByTestId(`channel-matrix-row-${entry.id}`);
      expect(within(row).getByRole("link", { name: new RegExp(entry.setupLabel) }).getAttribute("href")).toBe(entry.setupHref);
    }
  });

  it("covers exactly the six omnichannel surfaces", () => {
    expect(CHANNEL_CAPABILITY_MATRIX.map((entry) => entry.id)).toEqual(SURFACES);
    // Approvals are real in every implemented chat lane.
    for (const id of ["slack", "discord", "teams", "telegram"] as const) {
      const entry = CHANNEL_CAPABILITY_MATRIX.find((row) => row.id === id);
      expect(entry?.approvals.state).toBe("yes");
      expect(entry?.implementation).toBe("implemented");
    }
  });
});
