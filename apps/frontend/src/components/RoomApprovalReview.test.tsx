// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APPROVAL_TTL_MS, type PendingApproval } from "@shiba/shared";
import { RoomApprovalReview } from "./RoomApprovalReview";
import { personalFixture } from "../personal-execution-fixtures";

const workspaceId = `ws_${"a".repeat(24)}`,
  otherWorkspace = `ws_${"b".repeat(24)}`;
const hash = "a".repeat(64);
const approval = (): Omit<PendingApproval, "envSealed"> => ({
  threadKey: "web:requester",
  approvalId: "approval-1",
  collaborationHandoffId: "handoff-1",
  repoUrl: "https://github.com/acme/project",
  task: "Prepare the reviewed launch brief using the two selected room messages.",
  baseBranch: "main",
  publishPullRequest: true,
  runtime: "sandbox",
  sandboxProvider: "cloudflare",
  route: {
    purpose: "coding",
    harness: "codex",
    modelId: "coding-model",
    connectionId: "connection-1",
    policyVersion: 2,
  },
  status: "pending",
  createdAt: Date.now(),
  skillPins: [{ skillId: "skill-1", name: "Reviewed writing", version: 3 }],
  expectedDeliverables: ["brief.md"],
});
const card = () => ({
  approval: approval(),
  inputHash: hash,
  requesterUserId: "requester@example.com",
  handoffId: "handoff-1",
});
const props = {
  workspaceId,
  workspaceName: "Acme",
  roomId: "room-1",
  handoffId: "handoff-1",
  actorId: "requester@example.com",
};
const reviewed = () =>
  fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed this exact task/ }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("requester-only shared run approval", () => {
  it("shows the frozen own-account route before an explicit human decision", async () => {
    const personal = { ...personalFixture().grant.snapshot, actorId: props.actorId, workspaceId };
    const response = { ...card(), approval: { ...approval(), runtime: "local", targetMachineId: personal.machineId,
      repoUrl: personal.repoUrl, publishPullRequest: false, route: undefined, personalExecution: personal } };
    const fetcher = vi.fn(async () => Response.json(response)); vi.stubGlobal("fetch", fetcher);
    render(<RoomApprovalReview {...props} />);
    const button = await screen.findByRole("button", { name: "Approve run" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Fingerprint a{12} · billing native-subscription/)).toBeTruthy();
    expect(screen.getByText(/machine-personal · revision 3/)).toBeTruthy();
    expect(screen.getByText(/plex_c+ · v1 · expires/)).toBeTruthy();
    expect(screen.getByText(/Public repository https:\/\/github.com\/owner\/public-repo · exact model openai\/fixture-model/)).toBeTruthy();
    expect(screen.getByText(/Local repository task only/)).toBeTruthy();
    expect(screen.getByText(/A fresh configuration home is not an OS sandbox/)).toBeTruthy();
    expect(screen.queryByText(/connection deployment default/)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(["foreign-workspace", "foreign-account", "machine-change", "expired-grant", "publication"])("blocks a %s personal route before review", async (variant) => {
    const personal = { ...personalFixture().grant.snapshot, actorId: props.actorId, workspaceId };
    const record = { ...approval(), runtime: "local" as const, targetMachineId: personal.machineId, repoUrl: personal.repoUrl,
      publishPullRequest: false, route: undefined, personalExecution: personal };
    if (variant === "foreign-workspace") personal.workspaceId = otherWorkspace;
    if (variant === "foreign-account") personal.actorId = "another@example.test";
    if (variant === "machine-change") record.targetMachineId = "another-machine";
    if (variant === "expired-grant") personal.expiresAt = Date.now() - 1;
    if (variant === "publication") record.publishPullRequest = true;
    const fetcher = vi.fn(async () => Response.json({ ...card(), approval: record })); vi.stubGlobal("fetch", fetcher);
    render(<RoomApprovalReview {...props} />);
    await screen.findByRole("alert"); expect(screen.queryByRole("button", { name: "Approve run" })).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("shows the complete frozen scope without deciding until explicit review and approval", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
      Response.json(
        init?.method === "POST"
          ? { result: "approved", approvalId: "approval-1", inputHash: hash }
          : card(),
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    const decided = vi.fn();
    render(<RoomApprovalReview {...props} onDecided={decided} />);
    const button = await screen.findByRole("button", { name: "Approve run" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(decided).not.toHaveBeenCalled();
    expect(
      screen.getByText("Prepare the reviewed launch brief using the two selected room messages."),
    ).toBeTruthy();
    expect(
      screen.getByText(/Publishing its final frozen changes requires a separate human approval/),
    ).toBeTruthy();
    expect(screen.getByText(/No purchase, transfer, or amount-based spend approval/)).toBeTruthy();
    expect(screen.getByText(/Reviewed writing · v3/)).toBeTruthy();
    reviewed();
    fireEvent.click(button);
    await waitFor(() => expect(decided).toHaveBeenCalledWith("approved"));
    const call = fetcher.mock.calls.find((entry) => entry[1]?.method === "POST");
    expect(call?.[0]).toBe("/api/collaboration/rooms/room-1/handoffs/handoff-1/approval");
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      expectedInputHash: hash,
      reviewed: true,
      approved: true,
    });
    for (const [, init] of fetcher.mock.calls)
      expect(new Headers(init?.headers).get("X-Shiba-Workspace")).toBe(workspaceId);
    expect(screen.queryByRole("button", { name: "Approve run" })).toBeNull();
  });
  it("records an explicit rejection with the exact hash and never approves it", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
      Response.json(
        init?.method === "POST"
          ? { result: "rejected", approvalId: "approval-1", inputHash: hash }
          : card(),
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    const decided = vi.fn();
    render(<RoomApprovalReview {...props} onDecided={decided} />);
    await screen.findByRole("button", { name: "Reject run" });
    reviewed();
    fireEvent.click(screen.getByRole("button", { name: "Reject run" }));
    await waitFor(() => expect(decided).toHaveBeenCalledWith("rejected"));
    expect(
      JSON.parse(
        String(fetcher.mock.calls.find((entry) => entry[1]?.method === "POST")?.[1]?.body),
      ),
    ).toEqual({ expectedInputHash: hash, reviewed: true, approved: false });
    expect(screen.getByText(/Rejection recorded/)).toBeTruthy();
  });
  it("does not render another member's task or controls even if a cache returns its card", async () => {
    const fetcher = vi.fn(async () => Response.json(card()));
    vi.stubGlobal("fetch", fetcher);
    render(<RoomApprovalReview {...props} actorId="other@example.com" />);
    await screen.findByRole("alert");
    expect(screen.queryByText(/Prepare the reviewed launch brief/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve run" })).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("clears a displayed scope when current membership or selected sources are revoked", async () => {
    let revoked = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        revoked
          ? Response.json({ error: "Approval unavailable." }, { status: 404 })
          : Response.json(card()),
      ),
    );
    render(<RoomApprovalReview {...props} />);
    await screen.findByRole("button", { name: "Approve run" });
    reviewed();
    revoked = true;
    fireEvent(window, new Event("focus"));
    await screen.findByRole("alert");
    expect(screen.queryByText(/Prepare the reviewed launch brief/)).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
  it("suppresses duplicate clicks and treats replay/conflict as no further authority", async () => {
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "POST"
        ? new Promise<Response>((done) => {
            resolve = done;
          })
        : Response.json(card()),
    );
    vi.stubGlobal("fetch", fetcher);
    const decided = vi.fn();
    render(<RoomApprovalReview {...props} onDecided={decided} />);
    const button = await screen.findByRole("button", { name: "Approve run" });
    reviewed();
    fireEvent.click(button);
    fireEvent.click(button);
    expect(fetcher.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
    await act(async () => {
      resolve(
        Response.json(
          { error: "Approval was already consumed.", code: "approval_unavailable" },
          { status: 409 },
        ),
      );
    });
    expect((await screen.findByRole("alert")).textContent).toContain("already consumed");
    expect(decided).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Approve run" })).toBeNull();
  });
  it("clears the card on workspace/actor navigation and ignores the old decision response", async () => {
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST")
        return new Promise<Response>((done) => {
          resolve = done;
        });
      return new Headers(init?.headers).get("X-Shiba-Workspace") === workspaceId
        ? Response.json(card())
        : Response.json({ error: "Not found." }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetcher);
    const decided = vi.fn();
    const view = render(<RoomApprovalReview {...props} onDecided={decided} />);
    await screen.findByRole("button", { name: "Approve run" });
    reviewed();
    fireEvent.click(screen.getByRole("button", { name: "Approve run" }));
    view.rerender(
      <RoomApprovalReview
        {...props}
        workspaceId={otherWorkspace}
        actorId="other@example.com"
        onDecided={decided}
      />,
    );
    expect(screen.queryByText(/Prepare the reviewed launch brief/)).toBeNull();
    await act(async () => {
      resolve(Response.json({ result: "approved", approvalId: "approval-1", inputHash: hash }));
    });
    expect(decided).not.toHaveBeenCalled();
    expect(screen.queryByText(/Approval recorded/)).toBeNull();
    const request = fetcher.mock.calls.find((call) => call[1]?.method === "POST");
    expect(request?.[1]?.signal?.aborted).toBe(true);
  });
  it.each(["expired", "sealed", "handoff"])(
    "fails closed on an %s or mismatched record",
    async (kind) => {
      const frozen = card();
      if (kind === "expired") frozen.approval.createdAt = Date.now() - APPROVAL_TTL_MS - 1;
      if (kind === "sealed") Object.assign(frozen.approval, { envSealed: "must-not-be-rendered" });
      if (kind === "handoff") frozen.handoffId = "wrong-handoff";
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(frozen)),
      );
      render(<RoomApprovalReview {...props} />);
      await screen.findByRole("alert");
      expect(screen.queryByRole("button", { name: "Approve run" })).toBeNull();
      expect(screen.queryByText(/must-not-be-rendered/)).toBeNull();
    },
  );
  it("does not fetch without an authenticated actor and never invents approval authority", () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    render(<RoomApprovalReview {...props} actorId={null} />);
    expect(fetcher).not.toHaveBeenCalled();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve run" })).toBeNull();
  });
});
