// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SlackDraftSubmission } from "./SlackDraftSubmission";
import { personalFixture, PERSONAL_ACTOR, PERSONAL_WORKSPACE } from "../personal-execution-fixtures";
import type { PersonalExecutionSetupProps } from "./PersonalExecutionSetup";
vi.mock("./PersonalExecutionSetup", () => ({
  PersonalExecutionSetup: ({ onSelectionChange }: PersonalExecutionSetupProps) =>
    <button onClick={() => onSelectionChange(personalFixture().grant)}>Choose fixture grant</button>,
}));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const props = { workspaceId: PERSONAL_WORKSPACE, actorId: PERSONAL_ACTOR, roomId: "room_" + "a".repeat(24),
  draftId: "sd_" + "b".repeat(32), text: "Reviewed Slack statement", agents: ["agent:fixture"] };
function review() {
  fireEvent.change(screen.getByLabelText("Slack task agent"), { target: { value: "agent:fixture" } });
  fireEvent.click(screen.getByText("Choose fixture grant"));
  fireEvent.click(screen.getByRole("checkbox"));
}
describe("Slack source-fenced native submission", () => {
  it("queues exactly the selected source and grant, not private composer context or execution approval", async () => {
    const fetcher = vi.fn(async () => Response.json({ handoffId: "scx_" + "b".repeat(32), state: "queued", approvalRequired: true }));
    vi.stubGlobal("fetch", fetcher); render(<SlackDraftSubmission {...props} />);
    const submit = screen.getByRole("button", { name: "Submit Slack draft for approval" });
    expect(submit.hasAttribute("disabled")).toBe(true); expect(fetcher).not.toHaveBeenCalled();
    review(); fireEvent.click(submit); fireEvent.click(submit);
    await screen.findByText(/Human approval of the frozen task is still required/);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/slack/coworker/drafts/submit");
    expect(init.credentials).toBe("same-origin");
    expect(init.headers).toEqual({ "X-Shiba-Workspace": PERSONAL_WORKSPACE, "Content-Type": "application/json" });
    expect(JSON.parse(String(init.body))).toEqual({ id: props.draftId, roomId: props.roomId,
      recipientActorId: "agent:fixture", personalExecution: { grantId: personalFixture().grant.snapshot.grantId, expectedVersion: 1 }, reviewed: true });
  });
  for (const mode of ["unknown", "duplicate", "malformed", "lost"] as const) {
    it(`does not retry a ${mode} outcome`, async () => {
      const fetcher = vi.fn(async () => {
        if (mode === "lost") throw new Error("fixture transport failure");
        if (mode === "duplicate") return Response.json({ error: "already_submitted" }, { status: 409 });
        return Response.json({ handoffId: "scx_" + (mode === "malformed" ? "a" : "b").repeat(32), state: "unknown", approvalRequired: true });
      });
      vi.stubGlobal("fetch", fetcher); render(<SlackDraftSubmission {...props} />); review();
      const submit = screen.getByRole("button", { name: "Submit Slack draft for approval" });
      fireEvent.click(submit); await screen.findByRole("status"); fireEvent.click(submit);
      expect(submit.hasAttribute("disabled")).toBe(true); expect(fetcher).toHaveBeenCalledTimes(1);
    });
  }
  it("discards late receipts when the keyed identity review unmounts", async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(done => { resolve = done; })));
    const view = render(<SlackDraftSubmission {...props} />); review();
    fireEvent.click(screen.getByRole("button", { name: "Submit Slack draft for approval" }));
    view.unmount(); resolve(Response.json({ handoffId: "scx_" + "b".repeat(32), state: "queued", approvalRequired: true }));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
