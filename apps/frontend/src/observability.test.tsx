// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { reportDashboardRenderError, startDashboardObservability } from "./observability";

let stop: (() => void) | undefined;
afterEach(() => { stop?.(); stop = undefined; vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const flush = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); };
const setup = (status = { errors: true, analytics: true, metrics: true }) => {
  const fetcher = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) =>
    init?.method === "POST" ? new Response(null, { status: 204 }) : Response.json(status));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
};
const sent = (fetcher: ReturnType<typeof setup>) => fetcher.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => JSON.parse(init.body));

describe("dashboard observability", () => {
  it("installs nothing and sends nothing when disabled", async () => {
    const fetcher = setup({ errors: false, analytics: false, metrics: false });
    stop = startDashboardObservability();
    await flush();
    window.dispatchEvent(new Event("error"));
    reportDashboardRenderError();
    expect(sent(fetcher)).toEqual([]);
  });

  it("sends only fixed events, never the error, current URL, prompts or identity", async () => {
    const fetcher = setup();
    stop = startDashboardObservability();
    await flush();
    const privateError = new Error("secret prompt alice@example.test code snippet");
    window.dispatchEvent(new ErrorEvent("error", { error: privateError, message: privateError.message, filename: "private/customer.ts" }));
    window.dispatchEvent(new Event("unhandledrejection"));
    reportDashboardRenderError();
    expect(sent(fetcher)).toEqual([
      { event: "dashboard.opened" }, { event: "dashboard.unhandled_error" },
      { event: "dashboard.unhandled_rejection" }, { event: "dashboard.render_error" },
    ]);
    expect(JSON.stringify(fetcher.mock.calls)).not.toMatch(/alice|secret prompt|customer.ts/);
    stop();
    window.dispatchEvent(new Event("error"));
    reportDashboardRenderError();
    expect(sent(fetcher)).toHaveLength(4);
  });

  it("honors Do Not Track for activity and bounds error storms", async () => {
    vi.spyOn(navigator, "doNotTrack", "get").mockReturnValue("1");
    const fetcher = setup();
    stop = startDashboardObservability();
    await flush();
    expect(sent(fetcher)).toEqual([]);
    for (let i = 0; i < 50; i++) window.dispatchEvent(new Event("error"));
    expect(sent(fetcher)).toHaveLength(10);
  });

  it("ignores unavailable configuration, bad responses and transport failures", async () => {
    const fetcher = setup();
    fetcher.mockResolvedValueOnce(new Response(null, { status: 401 }));
    stop = startDashboardObservability();
    await flush();
    expect(sent(fetcher)).toEqual([]);
    stop();
    fetcher.mockResolvedValueOnce(Response.json({ errors: true, credentials: "private" }));
    stop = startDashboardObservability();
    await flush();
    expect(sent(fetcher)).toEqual([]);
    stop();
    fetcher.mockRejectedValue(new Error("offline"));
    stop = startDashboardObservability();
    await flush();
    expect(sent(fetcher)).toEqual([]);
  });

  it("does not install late listeners after cleanup", async () => {
    const fetcher = setup();
    stop = startDashboardObservability();
    stop();
    await flush();
    window.dispatchEvent(new Event("error"));
    expect(sent(fetcher)).toEqual([]);
  });
});
