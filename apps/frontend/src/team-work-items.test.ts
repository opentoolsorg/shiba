import { expect, it } from "vitest";
import { selectTeamWorkItems, type TeamWorkItem } from "./team-work-items";

const ws = "ws_a";
const item = (id: string, over: Partial<TeamWorkItem> = {}): TeamWorkItem => ({
  id,
  workspaceId: ws,
  roomId: "r",
  roomTitle: "R",
  title: id,
  assigneeKind: "human",
  status: "queued",
  updatedAt: 1,
  ...over,
});

const rows = [
  item("mine", { assigneeActorId: "human:me", updatedAt: 2 }),
  item("approve", { status: "needs-approval", approvalRequired: true, viewerCanApprove: true }),
  item("cannot-approve", {
    status: "needs-approval",
    approvalRequired: true,
    viewerCanApprove: false,
  }),
  item("agent", { assigneeKind: "agent", assigneeActorId: "human:me", updatedAt: 3 }),
  item("other-ws", { workspaceId: "ws_b", updatedAt: 9 }),
];

it("drops other workspaces and sorts newest first with a stable id tiebreak", () => {
  expect(selectTeamWorkItems(rows, ws, "all").map((t) => t.id)).toEqual([
    "agent",
    "mine",
    "approve",
    "cannot-approve",
  ]);
});

it("filters to human tasks assigned to the viewer", () => {
  expect(selectTeamWorkItems(rows, ws, "assigned", "human:me").map((t) => t.id)).toEqual(["mine"]);
  expect(selectTeamWorkItems(rows, ws, "assigned")).toEqual([]);
});

it("needs-you only includes approvals the server says the viewer may grant", () => {
  expect(selectTeamWorkItems(rows, ws, "needs-you").map((t) => t.id)).toEqual(["approve"]);
});
