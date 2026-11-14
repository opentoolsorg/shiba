// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OperatorEnrollmentReview } from "@shiba/shared";
import { OperatorEnrollmentReviews } from "./OperatorEnrollmentReviews";

function proposal(): OperatorEnrollmentReview {
  return { enrollmentId: `oe_${"1".repeat(32)}`, enrollmentGeneration: "11111111-1111-4111-8111-111111111111", provenance: "operator_api_key",
    proposalDigest: "a".repeat(64), provider: "fixture", accountLabel: "Fixture account", rawConnectionId: "fixture-row", upstreamRevision: "revision-1", personalAlias: `u_${"1".repeat(16)}`,
    deploymentEpoch: "fixture-epoch", versionId: "fixture-version", upstreamSourceRevision: "d89dc9f24f5a057bb500272d7dbf333837c77c68", manifestDigest: "b".repeat(64),
    operations: [{ actionId: "fixture/read", inputSchemaHash: "c".repeat(64), executorHash: "d".repeat(64) }],
    state: "proposed", version: 1, createdAt: Date.now(), expiresAt: Date.now() + 3600_000, decidedAt: null, revokedAt: null, executionAvailable: false };
}
const response = (rows: OperatorEnrollmentReview[], enabled = true) => Response.json({ actorId: "alice@example.test", ownerAccountId: "native-alice", enabled, executionAvailable: false, proposals: rows });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("owner enrollment reviews", () => {
  it("stays hidden with no owner or when disabled", async () => {
    const fetcher = vi.fn(async () => response([], false)); vi.stubGlobal("fetch", fetcher);
    const view = render(<OperatorEnrollmentReviews actorId={null} />);
    expect(fetcher).not.toHaveBeenCalled();
    view.rerender(<OperatorEnrollmentReviews actorId="alice@example.test" />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("region")).toBeNull();
  });
  it("requires explicit review and sends exact frozen decision without enabling execution", async () => {
    const row = proposal();
    const fetcher = vi.fn().mockResolvedValueOnce(response([row])).mockResolvedValueOnce(response([{ ...row, state: "accepted", version: 2, decidedAt: Date.now() }]));
    vi.stubGlobal("fetch", fetcher); render(<OperatorEnrollmentReviews actorId="alice@example.test" />);
    const accept = await screen.findByRole("button", { name: "Accept review only" });
    expect(accept.hasAttribute("disabled")).toBe(true);
    expect(screen.getAllByText("fixture/read").length).toBeGreaterThan(0);
    expect(screen.getByText(row.upstreamRevision).isConnected).toBe(true);
    fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(accept);
    await screen.findByText("Accepted for review only · Execution unavailable");
    expect(JSON.parse(fetcher.mock.calls[1]?.[1].body)).toEqual({ expectedOwnerAccountId: "native-alice", expectedVersion: 1, proposalDigest: row.proposalDigest, decision: "accept", reviewOnly: true });
    expect(fetcher.mock.calls[1]?.[0]).toBe(`/api/operator-enrollment-reviews/${row.enrollmentId}/decision`);
    expect(screen.getByRole("status").textContent).toContain("no employee access or action approval was granted");
    expect(screen.queryByRole("button", { name: /execute|connect|enable/i })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });
  it("prevents repeated decisions and refreshing while the outcome is pending", async () => {
    const row = proposal(); let finish!: (result: Response) => void;
    const fetcher = vi.fn().mockResolvedValueOnce(response([row])).mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal("fetch", fetcher); render(<OperatorEnrollmentReviews actorId="alice@example.test" />);
    const accept = await screen.findByRole("button", { name: "Accept review only" });
    fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(accept); fireEvent.click(accept);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Refresh reviews" }).hasAttribute("disabled")).toBe(true);
    await act(async () => finish(response([{ ...row, state: "accepted", version: 2, decidedAt: Date.now() }])));
  });
  it("discards late responses and review choices after owner changes", async () => {
    let first!: (result: Response) => void;
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { first = resolve; })).mockResolvedValueOnce(Response.json({ actorId: "bob@example.test", ownerAccountId: "native-bob", enabled: true, executionAvailable: false, proposals: [] }));
    vi.stubGlobal("fetch", fetcher); const view = render(<OperatorEnrollmentReviews actorId="alice@example.test" />);
    view.rerender(<OperatorEnrollmentReviews actorId="bob@example.test" />);
    await screen.findByText("No operator proposals to review.");
    await act(async () => first(response([proposal()])));
    expect(screen.queryByText("fixture: Fixture account")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
  it("clears stale metadata after conflict and does not retry uncertain decisions", async () => {
    const row = proposal(), fetcher = vi.fn().mockResolvedValueOnce(response([row])).mockResolvedValueOnce(Response.json({ error: "changed" }, { status: 409 }));
    vi.stubGlobal("fetch", fetcher); render(<OperatorEnrollmentReviews actorId="alice@example.test" />);
    await screen.findByRole("checkbox"); fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(screen.getByRole("button", { name: "Accept review only" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Refresh and review it again");
    expect(screen.queryByText("fixture: Fixture account")).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("withholds accept for expired proposals and supports explicit revocation", async () => {
    const row = { ...proposal(), state: "accepted" as const, version: 2, decidedAt: Date.now(), expiresAt: Date.now() - 1 };
    const fetcher = vi.fn().mockResolvedValueOnce(response([row])).mockResolvedValueOnce(response([{ ...row, state: "revoked", version: 3, revokedAt: Date.now() }]));
    vi.stubGlobal("fetch", fetcher); render(<OperatorEnrollmentReviews actorId="alice@example.test" />);
    fireEvent.click(await screen.findByRole("button", { name: "Revoke review" }));
    await screen.findByText("revoked · Execution unavailable");
    expect(screen.queryByRole("button", { name: "Accept review only" })).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("credential remains in OpenConnector");
  });
  it("does not trust an execution-ready server response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ actorId: "alice@example.test", ownerAccountId: "native-alice", enabled: true, executionAvailable: true, proposals: [proposal()] })));
    render(<OperatorEnrollmentReviews actorId="alice@example.test" />);
    expect((await screen.findByRole("alert")).textContent).toContain("could not be verified");
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
  it("rejects a different authenticated actor while the displayed identity is stale", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ actorId: "bob@example.test", ownerAccountId: "native-bob", enabled: true, executionAvailable: false, proposals: [proposal()] })));
    render(<OperatorEnrollmentReviews actorId="alice@example.test" />);
    expect((await screen.findByRole("alert")).textContent).toContain("Account identity changed");
    expect(screen.queryByText("fixture: Fixture account")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
  it("pins the native account even when a replacement reuses the displayed email", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response([proposal()])).mockResolvedValueOnce(Response.json({
      actorId: "alice@example.test", ownerAccountId: "replacement-alice", enabled: true, executionAvailable: false, proposals: [proposal()],
    }));
    vi.stubGlobal("fetch", fetcher); render(<OperatorEnrollmentReviews actorId="alice@example.test" />);
    await screen.findByRole("checkbox"); fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh reviews" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Account identity changed");
    expect(screen.queryByText("fixture: Fixture account")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

