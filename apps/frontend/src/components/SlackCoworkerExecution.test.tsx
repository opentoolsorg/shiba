// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SlackCoworkerPanel } from "./SlackCoworkerPanel";
import { SlackCoworkerClient } from "../slack-coworker-client";
const ws = `ws_${"a".repeat(24)}`,
  actor = "a@example.test",
  draftId = `sd_${"b".repeat(32)}`,
  roomId = `room_${"c".repeat(24)}`,
  previewId = `scp_${"d".repeat(32)}`,
  hash = "e".repeat(64);
const snapshot = {
  version: 1,
  grantId: `plex_${"f".repeat(32)}`,
  grantVersion: 1,
  ownerAccountId: "account",
  actorId: actor,
  workspaceId: ws,
  membershipVersion: 1,
  machineId: "machine",
  machineRevision: 1,
  harness: "codex",
  billingMode: "native-subscription",
  accountFingerprint: hash,
  authVersion: hash,
  codingModel: "openai/model",
  repoUrl: "https://github.com/owner/repo",
  expiresAt: Date.now() + 600000,
  allowedPhases: ["local_repository_task"],
};
vi.mock("./PersonalExecutionSetup", () => ({
  PersonalExecutionSetup: ({ onSelectionChange }: { onSelectionChange: (v: unknown) => void }) => (
    <button
      type="button"
      onClick={() => onSelectionChange({ snapshot, status: "active", version: 1 })}
    >
      Select owned grant
    </button>
  ),
}));
afterEach(cleanup);
it("reviews exact source and audience before one pending approval submission", async () => {
  const draft = {
    id: draftId,
    text: "Untrusted request",
    teamId: "T1",
    channelId: "C1",
    threadTs: "1.1",
    messageTs: "1.2",
    slackUserId: "U1",
    eventId: "E1",
  };
  const preview = {
    previewId,
    draftId,
    digest: hash,
    workspaceId: ws,
    actorId: actor,
    task: draft.text,
    roomId,
    roomTitle: "Private room",
    recipientActorId: "agent:one",
    employeeName: "One",
    employeeVersion: 1,
    personalExecution: snapshot,
    roomAudience: [{ actorId: `human:${actor}`, userId: actor, kind: "human", role: "owner" }],
    createdAt: Date.now(),
    expiresAt: Date.now() + 60000,
    consent: "share-my-slack-task-and-results-with-reviewed-room-audience",
  };
  const receipt = {
    previewId,
    draftId,
    roomId,
    handoffId: `scx_${"b".repeat(32)}`,
    state: "queued",
    approvalRequired: true,
  };
  let posted = 0;
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url);
    if (path.endsWith("/drafts/submissions"))
      return Response.json({ ok: true, workspaceId: ws, actorId: actor, submissions: [] });
    if (path.includes("/drafts/submission?"))
      return Response.json({
        ok: true,
        workspaceId: ws,
        actorId: actor,
        preview: null,
        receipt: null,
        sourceAvailable: true,
      });
    if (path.endsWith("/drafts/prepare-submission"))
      return Response.json({ ok: true, workspaceId: ws, actorId: actor, preview });
    if (path.endsWith("/drafts/submit")) {
      posted++;
      return Response.json({ ok: true, workspaceId: ws, actorId: actor, receipt });
    }
    if (path.endsWith("/api/collaboration/rooms"))
      return Response.json({ rooms: [{ roomId, title: "Private room" }] });
    if (path.endsWith(`/rooms/${roomId}`))
      return Response.json({
        room: { roomId, title: "Private room" },
        currentUserId: actor,
        members: [
          {
            actorId: "agent:one",
            actorKind: "agent",
            status: "active",
            displayName: "One",
            userId: "one",
          },
        ],
      });
    if (path.endsWith("/drafts")) return Response.json({ drafts: [draft] });
    return Response.json({ bindings: [], challenges: [], grants: [], executionAvailable: true });
  });
  const open = vi.fn();
  render(
    <SlackCoworkerPanel
      workspaceId={ws}
      actorId={actor}
      onAdoptTask={() => {}}
      onOpenHandoff={open}
      client={new SlackCoworkerClient(ws, actor, fetcher)}
    />,
  );
  await screen.findByText(draft.text);
  fireEvent.click(screen.getByText("Review native execution or status"));
  await screen.findByText("Choose an accessible room");
  fireEvent.change(screen.getByLabelText("Room"), { target: { value: roomId } });
  await screen.findByText("One");
  fireEvent.change(screen.getByLabelText("Employee"), { target: { value: "agent:one" } });
  fireEvent.click(screen.getByText("Select owned grant"));
  await waitFor(() =>
    expect((screen.getByText("Preview exact submission") as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByText("Preview exact submission"));
  await screen.findByText("Review the exact submission");
  expect(screen.getByText(/Room Private room/)).toBeTruthy();
  expect(screen.getByText(/native-subscription/)).toBeTruthy();
  fireEvent.click(screen.getByLabelText(/I consent to sharing/));
  fireEvent.click(screen.getByText("Request native approval"));
  await screen.findByText(/Submitted to the native approval flow/);
  expect(posted).toBe(1);
  fireEvent.click(screen.getByText("Open room handoff"));
  expect(open).toHaveBeenCalledWith(roomId, receipt.handoffId);
});
