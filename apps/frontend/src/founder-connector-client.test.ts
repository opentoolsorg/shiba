import { afterEach, describe, expect, it, vi } from "vitest";
import { FounderConnectorClient } from "./founder-connector-client";
import { FOUNDER_BASE, FOUNDER_LIBRARY, FOUNDER_WORKSPACE, founderOptions, founderPlan, enabledFounderPlan, founderOccurrence, founderState, withFounderApproval } from "./founder-connector-fixtures";

afterEach(() => vi.unstubAllGlobals());
const signal = () => new AbortController().signal;
const client = () => new FounderConnectorClient(FOUNDER_WORKSPACE, FOUNDER_LIBRARY);
const respond = (body: unknown, status = 200) => {
  const fetcher = vi.fn(async () => Response.json(body, { status })); vi.stubGlobal("fetch", fetcher); return fetcher;
};
async function failure(operation: Promise<unknown>): Promise<string> {
  const result = await operation.then(() => null, (error: unknown) => error);
  expect(result).toBeInstanceOf(Error);
  return (result as Error).message;
}

describe("founder connector HTTP contract", () => {
  it("pins native workspace and recipe headers and starts no action during reads", async () => {
    const fetcher = respond(founderOptions());
    await client().options(signal());
    const [path, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe(`${FOUNDER_BASE}/options`);
    expect(new Headers(init.headers).get("X-Shiba-Workspace")).toBe(FOUNDER_WORKSPACE);
    expect(init).toMatchObject({ method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error" });
    expect(init.body).toBeUndefined();
  });
  it.each(["workspace", "recipe", "actor"])("rejects a changed %s response before adopting protected state", async (field) => {
    const instance = client(); respond(founderOptions()); await instance.options(signal());
    respond({ ...founderState(founderPlan()), ...(field === "workspace" ? { workspaceId: `ws_${"b".repeat(24)}` } : field === "recipe" ? { libraryId: "founder-pr-digest" } : { actorId: "other@example.test" }) });
    expect(await failure(instance.read(signal()))).toMatch(/another account or workspace/);
  });
  it("checks the account and employee revision in action metadata", async () => {
    respond({ ...founderState(), connectionId: "wrong-account", employeeId: "employee-one", employeeVersion: 2, actions: [] });
    expect(await failure(client().actions("account-one", "employee-one", 2, "subscriptions", signal()))).toMatch(/another account or employee/);
  });
  it("validates prepared plan bytes rather than accepting any successful receipt", async () => {
    const plan = founderPlan();
    const input = { employeeId: plan.contract.employeeId, employeeVersion: 2, skillId: "skill-one", skillVersion: 3, connectionId: "account-one", connectionVersion: 4,
      actionId: plan.contract.actionId, arguments: plan.contract.arguments, cadence: "daily" as const, localTime: "09:00", timezone: "UTC", expiresAt: plan.contract.expiresAt, expectedVersion: 0 };
    respond(founderState(plan));
    expect((await client().prepare(input, signal())).plan?.id).toBe(plan.id);
    respond(founderState({ ...plan, contract: { ...plan.contract, arguments: { limit: 100 } } }));
    expect(await failure(client().prepare(input, signal()))).toMatch(/does not match your exact configuration/);
  });
  it("sends exact plan CAS and refuses unrelated enable receipts", async () => {
    const plan = founderPlan(), fetcher = respond(founderState({ ...plan, version: 2, state: "enabled", canEnable: false, canPause: true }));
    await client().decidePlan("enable", plan, signal());
    const [path, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe(`${FOUNDER_BASE}/enable`); expect(JSON.parse(String(init.body))).toEqual({ expectedVersion: 1, digest: plan.digest, reviewed: true });
    respond(founderState({ ...plan, id: "foreign-plan", version: 2, state: "enabled" }));
    expect(await failure(client().decidePlan("enable", plan, signal()))).toMatch(/exact schedule change/);
  });
  it("pins complete occurrence approval and refuses mismatched arguments or execution receipts", async () => {
    const plan = enabledFounderPlan(), item = founderOccurrence(plan), approved = withFounderApproval(item, "approved");
    const instance = client(); respond(founderState(plan, [approved])); await instance.read(signal());
    const done = withFounderApproval(item, "completed"), fetcher = respond(founderState(plan, [done]));
    await instance.executeOccurrence(plan, approved, signal());
    const [path, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe(`${FOUNDER_BASE}/occurrences/${item.id}/execute`);
    expect(JSON.parse(String(init.body))).toEqual({ expectedVersion: 2, digest: plan.digest, occurrenceDigest: item.digest, approvalId: "wca-one", inputHash: "f".repeat(64) });
    respond(founderState(plan, [{ ...done, approval: { ...done.approval!, id: "wrong-approval" } }]));
    expect(await failure(instance.executeOccurrence(plan, approved, signal()))).toMatch(/execution receipt could not be confirmed/);
    respond(founderState(plan, [{ ...done, approval: { ...done.approval!, arguments: { limit: 99 } } }]));
    expect(await failure(instance.read(signal()))).toMatch(/does not match the exact plan/);
  });
  it("does not retry a rejected or uncertain action and honors cancellation before sending", async () => {
    const instance = client(), plan = enabledFounderPlan(), item = withFounderApproval(founderOccurrence(plan), "approved");
    respond(founderState(plan, [item])); await instance.read(signal());
    const fetcher = respond({ error: "do not echo upstream secrets" }, 409);
    expect(await failure(instance.executeOccurrence(plan, item, signal()))).toMatch(/changed/); expect(fetcher).toHaveBeenCalledOnce();
    const stopped = new AbortController(); stopped.abort();
    await expect(instance.options(stopped.signal)).rejects.toThrow(); expect(fetcher).toHaveBeenCalledOnce();
  });
  it("calls native browser fetch with its global receiver", async () => {
    const fetcher = vi.fn(async function (this: unknown) { expect(this).toBe(globalThis); return Response.json(founderOptions()); });
    vi.stubGlobal("fetch", fetcher);
    await client().options(signal());
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
