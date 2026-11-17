import { describe, expect, it, vi } from "vitest";
import { optimisticMutation } from "./optimistic";

describe("optimistic mutations", () => {
  it("applies before HTTP settles and reconciles the server identity", async () => {
    let settle!: (value: string) => void;
    const request = new Promise<string>((resolve) => { settle = resolve; });
    const rows: string[] = [];
    const rollback = vi.fn(), onError = vi.fn();
    const mutation = optimisticMutation({
      apply: () => rows.push("pending"), commit: () => request,
      reconcile: (id) => { rows.splice(rows.indexOf("pending"), 1, id); }, rollback, onError,
    });
    expect(rows).toEqual(["pending"]);
    settle("server-id");
    await expect(mutation).resolves.toBe("server-id");
    expect(rows).toEqual(["server-id"]);
    expect(rollback).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("removes only the failed item and reports the error", async () => {
    const rows = ["existing"];
    const error = new Error("Offline");
    const onError = vi.fn();
    await optimisticMutation({
      apply: () => rows.push("pending"), commit: async () => { rows.push("remote-item"); throw error; },
      reconcile: vi.fn(), rollback: () => { rows.splice(rows.indexOf("pending"), 1); }, onError,
    });
    expect(rows).toEqual(["existing", "remote-item"]);
    expect(onError).toHaveBeenCalledWith(error);
  });
});
