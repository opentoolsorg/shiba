// @vitest-environment happy-dom
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useApprovalsState } from "./approvals";

describe("approvals single owner", () => {
  it("loads stored approvals once for shared surfaces", async () => {
    const fetchMock = vi.fn(async () => Response.json({ approvals: [{ approvalId: "a1", status: "pending" }], decided: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useApprovalsState(1, true, true));
    await waitFor(() => expect(result.current.approvals.length).toBe(1));
    expect(fetchMock).toHaveBeenCalledWith("/api/approvals");
    vi.unstubAllGlobals();
  });
});