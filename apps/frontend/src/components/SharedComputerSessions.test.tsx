// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPUTER_FIXTURE_SCOPE, sharedComputerFixture } from "../shared-computer-fixtures";
import { SharedComputerSessions } from "./SharedComputerSessions";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function fixture(
  mode: "draft" | "funded" | "running" | "lease" = "draft",
  actorId = COMPUTER_FIXTURE_SCOPE.actorId,
) {
  const data = sharedComputerFixture();
  data.state.actorId = actorId;
  data.session.state = mode === "lease" ? "running" : mode;
  data.session.canStart = mode === "funded";
  data.session.canFund = mode === "draft" && actorId === "operator@example.test";
  data.session.canControl = ["running", "lease"].includes(mode);
  data.session.canView = ["running", "lease"].includes(mode);
  data.session.consumed = ["running", "lease"].includes(mode);
  if (mode === "lease")
    data.session.lease = { ownerId: actorId, version: 2, expiresAt: Date.now() + 60000 };
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const fetcher = vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
    const url = String(path);
    calls.push({ path: url, init });
    if (url.includes("/state?")) return Response.json(data.state);
    if (url.endsWith("/capture"))
      return new Response(new Uint8Array([255, 216, 255, 217]), {
        headers: { "content-type": "image/jpeg", "cache-control": "no-store, private" },
      });
    if (url.endsWith("/stop")) {
      data.session.state = "stopped";
      data.session.canView = data.session.canControl = data.session.canStop = false;
      return Response.json({ ok: true, stopped: true });
    }
    if (url.endsWith("/fund")) {
      data.session.state = "funded";
      data.session.version++;
      data.session.canFund = false;
    }
    if (url.endsWith("/start")) {
      data.session.state = "running";
      data.session.version += 2;
      data.session.consumed = true;
      data.session.canStart = false;
      data.session.canView = data.session.canControl = true;
    }
    if (url.endsWith("/lease")) {
      data.session.lease = { ownerId: actorId, version: 2, expiresAt: Date.now() + 60000 };
      data.session.version++;
    }
    if (url.endsWith("/input")) {
      data.session.nextSequence++;
      data.session.inputCount++;
    }
    return Response.json(
      { ok: true, session: data.session },
      { status: url.endsWith("/prepare") ? 201 : 200 },
    );
  });
  vi.stubGlobal("fetch", fetcher);
  const props = { ...COMPUTER_FIXTURE_SCOPE, actorId };
  return { ...data, props, calls, fetcher };
}
async function selectSession(id: string) {
  await screen.findByLabelText("Shared-computer session");
  fireEvent.change(screen.getByLabelText("Shared-computer session"), { target: { value: id } });
}
describe("explicit offline shared computer UI", () => {
  it("selects no session, operator, viewers, controllers, funding or capture automatically", async () => {
    const f = fixture();
    render(<SharedComputerSessions {...f.props} />);
    await screen.findByLabelText("Shared-computer session");
    expect(screen.getByLabelText("Shared-computer session")).toHaveProperty("value", "");
    fireEvent.click(screen.getByText("Prepare a separate offline desktop"));
    expect(screen.getByLabelText("Explicit deployment funding operator")).toHaveProperty(
      "value",
      "",
    );
    expect(screen.getByLabelText("Fixed desktop expiry")).toHaveProperty("value", "");
    expect(screen.getAllByRole("checkbox").every((box) => !(box as HTMLInputElement).checked)).toBe(
      true,
    );
    expect(f.calls.every((call) => call.init?.method === "GET")).toBe(true);
  });
  it("shows unavailable configuration without start buttons or a fake desktop", async () => {
    const f = fixture();
    f.state.available = false;
    f.state.unavailableReason = "shared_computer_image_unavailable";
    render(<SharedComputerSessions {...f.props} />);
    await screen.findByText(/Unavailable: shared_computer_image_unavailable/);
    expect(screen.queryByText("Prepare a separate offline desktop")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
    expect(f.calls).toHaveLength(1);
  });
  it("requires complete exact funding consent and never starts during funding", async () => {
    const f = fixture("draft", "operator@example.test");
    render(<SharedComputerSessions {...f.props} />);
    await selectSession(f.session.id);
    const button = screen.getByRole("button", { name: "Authorize exact desktop funding" });
    expect(button).toHaveProperty("disabled", true);
    const frozen = screen.getByText("Exact image and approval digest").parentElement!.textContent;
    expect(frozen).toContain(f.session.contract.image);
    expect(frozen).toContain(f.session.digest);
    fireEvent.click(screen.getByLabelText(/As the bootstrap operator/));
    fireEvent.click(button);
    await waitFor(() =>
      expect(f.calls.filter((call) => call.path.endsWith("/fund"))).toHaveLength(1),
    );
    expect(
      JSON.parse(String(f.calls.find((call) => call.path.endsWith("/fund"))!.init!.body)),
    ).toEqual({
      expectedVersion: 1,
      digest: f.session.digest,
      reviewed: true,
      billingConsent: true,
    });
    expect(
      f.calls.some((call) => call.path.endsWith("/start") || call.path.endsWith("/capture")),
    ).toBe(false);
  });
  it("requires separate frozen owner sharing review before start and prevents uncertain retries", async () => {
    const f = fixture("funded"),
      original = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation((path, init) =>
      String(path).endsWith("/start")
        ? Promise.resolve(Response.json({ error: "private never render" }, { status: 503 }))
        : original(path, init),
    );
    render(<SharedComputerSessions {...f.props} />);
    await selectSession(f.session.id);
    const start = screen.getByRole("button", { name: "Start reviewed offline computer" });
    expect(start).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByLabelText(/I consent to sharing the entire display/));
    fireEvent.click(start);
    await screen.findByRole("alert");
    fireEvent.click(start);
    expect(f.fetcher.mock.calls.filter(([path]) => String(path).endsWith("/start"))).toHaveLength(
      1,
    );
    expect(screen.queryByText(/private never render/)).toBeNull();
  });
  it("does not send input until the human explicitly claims its named control lease", async () => {
    const f = fixture("running");
    render(<SharedComputerSessions {...f.props} />);
    await selectSession(f.session.id);
    expect(
      screen.getByRole("group", { name: "Human input for my current exclusive lease" }),
    ).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Claim exclusive 60-second control" }));
    await waitFor(() =>
      expect(
        screen.getByRole("group", { name: "Human input for my current exclusive lease" }),
      ).toHaveProperty("disabled", false),
    );
    fireEvent.change(screen.getByLabelText("Literal shared text"), {
      target: { value: "Literal ; $(not a shell)" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Type exact shared text" }));
    await waitFor(() =>
      expect(f.calls.filter((call) => call.path.endsWith("/input"))).toHaveLength(1),
    );
    expect(
      JSON.parse(String(f.calls.find((call) => call.path.endsWith("/input"))!.init!.body)),
    ).toMatchObject({
      expectedVersion: 2,
      leaseVersion: 2,
      sequence: 1,
      digest: f.session.digest,
      action: { type: "type", text: "Literal ; $(not a shell)" },
    });
    expect(
      f.calls.some(
        (call) => call.path.includes("/api/runs/") || call.path.includes("/harness/control"),
      ),
    ).toBe(false);
  });
  it("uses a private object URL only after explicit capture and current source state, then revokes on scope switch", async () => {
    const f = fixture("running");
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fixture-private");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const view = render(<SharedComputerSessions {...f.props} />);
    await selectSession(f.session.id);
    expect(screen.queryByRole("img")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Capture current display" }));
    const img = await screen.findByRole("img");
    expect(img.getAttribute("src")).toBe("blob:fixture-private");
    view.rerender(<SharedComputerSessions {...f.props} actorId="viewer@example.test" />);
    await waitFor(() => expect(screen.queryByRole("img")).toBeNull());
    expect(revoke).toHaveBeenCalledWith("blob:fixture-private");
  });
  it("does not adopt a late initial state from another actor or room", async () => {
    const f = fixture();
    let resolve!: (response: Response) => void;
    f.fetcher.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const view = render(<SharedComputerSessions {...f.props} />);
    await waitFor(() => expect(resolve).toBeTypeOf("function"));
    view.rerender(<SharedComputerSessions {...f.props} actorId="viewer@example.test" />);
    await act(async () => {
      resolve(Response.json(f.state));
    });
    expect(screen.queryByText(f.session.contract.image)).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
    expect(f.calls.some((call) => call.init?.method === "POST")).toBe(false);
  });
  it("keeps dedicated STOP reachable during an unsettled input and ignores its late receipt", async () => {
    const f = fixture("lease"),
      original = f.fetcher.getMockImplementation()!;
    let resolve!: (response: Response) => void;
    f.fetcher.mockImplementation((path, init) =>
      String(path).endsWith("/input")
        ? new Promise((done) => {
            resolve = done;
          })
        : original(path, init),
    );
    render(<SharedComputerSessions {...f.props} />);
    await selectSession(f.session.id);
    fireEvent.click(screen.getByRole("button", { name: "Tab" }));
    await waitFor(() => expect(resolve).toBeTypeOf("function"));
    const stop = screen.getByRole("button", { name: /^Stop dedicated desktop/ });
    expect(stop).toHaveProperty("disabled", false);
    fireEvent.click(stop);
    await screen.findByText(/Dedicated desktop destruction acknowledged/);
    await act(async () => {
      resolve(
        Response.json({
          ok: true,
          session: { ...f.session, state: "running", canView: true, canControl: true },
        }),
      );
    });
    expect(screen.queryByRole("button", { name: "Capture current display" })).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
  });
  it("starts sampled refresh only on request and fences a late capture after STOP", async () => {
    const f = fixture("running"),
      original = f.fetcher.getMockImplementation()!;
    let resolve!: (response: Response) => void;
    f.fetcher.mockImplementation((path, init) =>
      String(path).endsWith("/capture")
        ? new Promise((done) => {
            resolve = done;
          })
        : original(path, init),
    );
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:private");
    render(<SharedComputerSessions {...f.props} />);
    await selectSession(f.session.id);
    expect(f.calls.filter((call) => call.path.endsWith("/capture"))).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Start live refresh" }));
    await waitFor(() => expect(resolve).toBeTypeOf("function"));
    fireEvent.click(screen.getByRole("button", { name: /^Stop dedicated desktop/ }));
    await screen.findByText(/Dedicated desktop destruction acknowledged/);
    await act(async () => {
      resolve(
        new Response(new Uint8Array([255, 216, 255, 217]), {
          headers: { "content-type": "image/jpeg", "cache-control": "no-store, private" },
        }),
      );
    });
    expect(create).not.toHaveBeenCalled();
    expect(screen.queryByRole("img")).toBeNull();
  });
  it("does not display a sampled frame when the viewer loses access before the post-capture check", async () => {
    const f = fixture("running"),
      original = f.fetcher.getMockImplementation()!;
    let resolve!: (response: Response) => void;
    f.fetcher.mockImplementation((path, init) =>
      String(path).endsWith("/capture")
        ? new Promise((done) => {
            resolve = done;
          })
        : original(path, init),
    );
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:private");
    render(<SharedComputerSessions {...f.props} />);
    await selectSession(f.session.id);
    fireEvent.click(screen.getByRole("button", { name: "Start live refresh" }));
    await waitFor(() => expect(resolve).toBeTypeOf("function"));
    f.session.canView = false;
    await act(async () => {
      resolve(
        new Response(new Uint8Array([255, 216, 255, 217]), {
          headers: { "content-type": "image/jpeg", "cache-control": "no-store, private" },
        }),
      );
    });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Stop live refresh" })).toBeNull(),
    );
    expect(create).not.toHaveBeenCalled();
    expect(screen.queryByRole("img")).toBeNull();
  });
  it("fences an in-flight frame when the tab becomes hidden", async () => {
    const f = fixture("running"),
      original = f.fetcher.getMockImplementation()!;
    let resolve!: (response: Response) => void;
    f.fetcher.mockImplementation((path, init) =>
      String(path).endsWith("/capture")
        ? new Promise((done) => {
            resolve = done;
          })
        : original(path, init),
    );
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:private");
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    render(<SharedComputerSessions {...f.props} />);
    await selectSession(f.session.id);
    fireEvent.click(screen.getByRole("button", { name: "Start live refresh" }));
    await waitFor(() => expect(resolve).toBeTypeOf("function"));
    hidden.mockReturnValue(true);
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => {
      resolve(
        new Response(new Uint8Array([255, 216, 255, 217]), {
          headers: { "content-type": "image/jpeg", "cache-control": "no-store, private" },
        }),
      );
    });
    expect(create).not.toHaveBeenCalled();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByRole("button", { name: "Start live refresh" })).toBeTruthy();
  });
  it("limits an opt-in refresh run to fifteen captures and never overlaps them", async () => {
    const f = fixture("running");
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:private");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const interval = globalThis.setInterval;
    let tick: (() => void) | undefined;
    vi.spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void, ms: number) => {
      if (ms === 2000) tick = callback;
      return interval(callback, ms);
    }) as typeof setInterval);
    render(<SharedComputerSessions {...f.props} />);
    await selectSession(f.session.id);
    fireEvent.click(screen.getByRole("button", { name: "Start live refresh" }));
    await waitFor(() =>
      expect(f.calls.filter((call) => call.path.endsWith("/capture"))).toHaveLength(1),
    );
    for (let count = 2; count <= 15; count++) {
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Capture current display" })).toHaveProperty(
          "disabled",
          false,
        ),
      );
      await act(async () => {
        tick?.();
        tick?.();
      });
      await waitFor(() =>
        expect(f.calls.filter((call) => call.path.endsWith("/capture"))).toHaveLength(count),
      );
    }
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Capture current display" })).toHaveProperty(
        "disabled",
        false,
      ),
    );
    await act(async () => {
      tick?.();
    });
    expect(f.calls.filter((call) => call.path.endsWith("/capture"))).toHaveLength(15);
    expect(screen.getByRole("button", { name: "Start live refresh" })).toBeTruthy();
  });
  it("stops sampled refresh on a failed capture without retrying", async () => {
    const f = fixture("running"),
      original = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation((path, init) =>
      String(path).endsWith("/capture")
        ? Promise.resolve(new Response(null, { status: 403 }))
        : original(path, init),
    );
    render(<SharedComputerSessions {...f.props} />);
    await selectSession(f.session.id);
    fireEvent.click(screen.getByRole("button", { name: "Start live refresh" }));
    await screen.findByRole("alert");
    expect(f.fetcher.mock.calls.filter(([path]) => String(path).endsWith("/capture"))).toHaveLength(
      1,
    );
    expect(screen.queryByRole("img")).toBeNull();
  });
  it("keeps at most one metadata refresh pending without hidden retries", async () => {
    const f = fixture("running"),
      base = f.fetcher.getMockImplementation();
    if (!base) throw new Error("Missing fixture implementation");
    let resolve!: (response: Response) => void,
      poll: (() => void) | undefined,
      reads = 0;
    f.fetcher.mockImplementation((path, init) => {
      if (String(path).includes("/state?") && ++reads > 1)
        return new Promise((done) => {
          resolve = done;
        });
      return base(path, init);
    });
    const interval = globalThis.setInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void, ms: number) => {
      if (ms === 5000) poll = callback;
      return interval(callback, ms);
    }) as typeof setInterval);
    render(<SharedComputerSessions {...f.props} />);
    await selectSession(f.session.id);
    await act(async () => {
      poll?.();
      poll?.();
      poll?.();
    });
    expect(reads).toBe(2);
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    await act(async () => {
      resolve(Response.json(f.state));
    });
  });
});
