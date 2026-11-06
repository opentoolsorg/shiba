import { describe, expect, it, vi } from "vitest";
import { SharedComputerClient } from "./shared-computer-client";
import { COMPUTER_FIXTURE_SCOPE, sharedComputerFixture } from "./shared-computer-fixtures";

describe("shared computer exact-scope client", () => {
  it("uses explicit native workspace headers and performs no constructor mutation", async () => {
    const fixture = sharedComputerFixture(),
      fetcher = vi.fn(async () => Response.json(fixture.state));
    const client = new SharedComputerClient(COMPUTER_FIXTURE_SCOPE, fetcher);
    expect(fetcher).not.toHaveBeenCalled();
    await client.state(new AbortController().signal);
    expect(fetcher.mock.calls).toHaveLength(1);
    const call = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe(`/api/shared-computers/state?roomId=${COMPUTER_FIXTURE_SCOPE.roomId}`);
    expect(call[1]).toMatchObject({
      method: "GET",
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
      headers: { "X-Shiba-Workspace": COMPUTER_FIXTURE_SCOPE.workspaceId },
    });
  });
  it.each(["actorId", "roomId", "workspaceId"])(
    "rejects a response from another %s",
    async (field) => {
      const f = sharedComputerFixture();
      const bad =
        field === "actorId"
          ? "other@example.test"
          : field === "roomId"
            ? `room_${"b".repeat(24)}`
            : "other";
      await expect(
        new SharedComputerClient(COMPUTER_FIXTURE_SCOPE, async () =>
          Response.json({ ...f.state, [field]: bad }),
        ).state(new AbortController().signal),
      ).rejects.toThrow();
    },
  );
  it("binds funding and start to exact reviewed digest/version and distinct consents", async () => {
    const f = sharedComputerFixture(),
      calls: RequestInit[] = [],
      client = new SharedComputerClient(COMPUTER_FIXTURE_SCOPE, async (path, init) => {
        calls.push(init!);
        return Response.json({
          ok: true,
          session: {
            ...f.session,
            state: String(path).endsWith("/fund") ? "funded" : "running",
            version: String(path).endsWith("/fund") ? 2 : 4,
            consumed: !String(path).endsWith("/fund"),
          },
        });
      });
    await client.fund(f.session, new AbortController().signal);
    await client.start({ ...f.session, state: "funded", version: 2 }, new AbortController().signal);
    expect(JSON.parse(String(calls[0]!.body))).toEqual({
      expectedVersion: 1,
      digest: f.session.digest,
      reviewed: true,
      billingConsent: true,
    });
    expect(JSON.parse(String(calls[1]!.body))).toEqual({
      expectedVersion: 2,
      digest: f.session.digest,
      reviewed: true,
      sharedDisplayConsent: true,
    });
  });
  it("refuses input without the selected actor's exclusive lease before HTTP", () => {
    const f = sharedComputerFixture(),
      fetcher = vi.fn(),
      client = new SharedComputerClient(COMPUTER_FIXTURE_SCOPE, fetcher);
    expect(() =>
      client.input(
        f.session,
        { type: "key", key: "Tab" },
        crypto.randomUUID(),
        new AbortController().signal,
      ),
    ).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["wrong-mime", "missing-no-store", "incomplete", "oversized"])(
    "rejects %s capture without accepting a public URL",
    async (mode) => {
      const f = sharedComputerFixture(),
        bytes =
          mode === "oversized"
            ? new Uint8Array(524289)
            : mode === "incomplete"
              ? new Uint8Array([255, 216, 0, 0])
              : new Uint8Array([255, 216, 255, 217]);
      const client = new SharedComputerClient(
        COMPUTER_FIXTURE_SCOPE,
        async () =>
          new Response(bytes, {
            headers: {
              "content-type": mode === "wrong-mime" ? "text/html" : "image/jpeg",
              "cache-control": mode === "missing-no-store" ? "public" : "no-store, private",
            },
          }),
      );
      await expect(client.capture(f.session, new AbortController().signal)).rejects.toThrow();
    },
  );
  it("does not expose raw failed response data or retry a request", async () => {
    const f = sharedComputerFixture(),
      fetcher = vi.fn(async () =>
        Response.json({ error: "private fixture content" }, { status: 503 }),
      );
    await expect(
      new SharedComputerClient(COMPUTER_FIXTURE_SCOPE, fetcher).start(
        f.session,
        new AbortController().signal,
      ),
    ).rejects.not.toThrow(/private fixture/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(["different-id", "changed-audience", "wrong-version"])(
    "rejects a %s receipt for the reviewed start",
    async (kind) => {
      const f = sharedComputerFixture(),
        before = { ...f.session, state: "funded" as const, version: 2 };
      const next = {
        ...f.session,
        state: "running",
        version: 4,
        consumed: true,
        ...(kind === "different-id" ? { id: `scs_${"b".repeat(32)}` } : {}),
        ...(kind === "changed-audience"
          ? {
              contract: {
                ...f.session.contract,
                viewers: [...f.session.contract.viewers, "unreviewed@example.test"],
              },
            }
          : {}),
        ...(kind === "wrong-version" ? { version: 3 } : {}),
      };
      await expect(
        new SharedComputerClient(COMPUTER_FIXTURE_SCOPE, async () =>
          Response.json({ ok: true, session: next }),
        ).start(before, new AbortController().signal),
      ).rejects.toThrow();
    },
  );
  it("rejects preparation that changes the explicitly selected audience or expiry", async () => {
    const f = sharedComputerFixture(),
      input = {
        requestId: crypto.randomUUID(),
        roomId: COMPUTER_FIXTURE_SCOPE.roomId,
        fundingMember: { userId: "operator@example.test", version: 2 },
        viewers: [{ userId: COMPUTER_FIXTURE_SCOPE.actorId, version: 1 }],
        controllers: [COMPUTER_FIXTURE_SCOPE.actorId],
        expiresAt: f.session.contract.expiresAt,
      };
    await expect(
      new SharedComputerClient(COMPUTER_FIXTURE_SCOPE, async () =>
        Response.json({ ok: true, session: f.session }),
      ).prepare(input, new AbortController().signal),
    ).rejects.toThrow();
  });
});
