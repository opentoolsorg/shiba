// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { RunOutputArchivePanel } from "./RunOutputArchivePanel";
import { archiveFixture, OUTPUT_RUN, OUTPUT_SESSION } from "../run-output-archive-fixtures";
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const props = { runId: OUTPUT_RUN, sessionId: OUTPUT_SESSION, onClose: vi.fn() };
it("reads only the selected native run prefix and explains unknown tail without execution controls", async () => {
  const f = archiveFixture(), fetcher = vi.fn(async (input: RequestInfo | URL) => Response.json(String(input).includes("?after=") ? f.page : f.directory)); vi.stubGlobal("fetch", fetcher);
  render(<RunOutputArchivePanel {...props} />); await screen.findByTestId("retained-archive-content");
  expect(screen.getByText(/The unacknowledged tail is unknown/)).toBeTruthy(); expect(fetcher).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("button", { name: /execute|approve|restart|download|send/i })).toBeNull();
});
it("restarts its GET-only observation under StrictMode without retaining a stale pending latch", async () => {
  const f = archiveFixture(); vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => Response.json(String(input).includes("?after=") ? f.page : f.directory)));
  render(<StrictMode><RunOutputArchivePanel {...props} /></StrictMode>);
  expect((await screen.findByTestId("retained-archive-content")).textContent).toContain("retained prefix");
});
it("clears protected prefix when current source access is revoked on focus", async () => {
  const f = archiveFixture(); let revoked = false;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => revoked ? new Response(null, { status: 404 }) : Response.json(String(input).includes("?after=") ? f.page : f.directory)));
  render(<RunOutputArchivePanel {...props} />); await screen.findByTestId("retained-archive-content"); revoked = true; fireEvent(window, new Event("focus"));
  await screen.findByRole("alert"); expect(screen.queryByTestId("retained-archive-content")).toBeNull();
});
it("rejects late A bytes after switching to another run/session without a Blob or download", async () => {
  const f = archiveFixture(); let finish!: (value: Response) => void; const late = new Promise<Response>((resolve) => { finish = resolve; });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).includes("?after=") ? late : Response.json(f.directory)));
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  const view = render(<RunOutputArchivePanel {...props} />); await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(2));
  view.rerender(<RunOutputArchivePanel {...props} runId="agent-tool:B" sessionId="11111111-1111-4111-8111-111111111111" />);
  await screen.findByText(/No current private archive was approved/); await act(async () => finish(Response.json(f.page)));
  expect(screen.queryByTestId("retained-archive-content")).toBeNull(); expect(click).not.toHaveBeenCalled();
});
it("hides exact-lease content without waiting for a poll", async () => {
  vi.useFakeTimers(); const f = archiveFixture(); f.page.expiresAt = Date.now() + 50; f.directory.archives[0]!.expiresAt = f.page.expiresAt;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => Response.json(String(input).includes("?after=") ? f.page : f.directory)));
  render(<RunOutputArchivePanel {...props} />); await act(async () => { await vi.advanceTimersByTimeAsync(0); }); expect(screen.getByTestId("retained-archive-content")).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(51); }); expect(screen.queryByTestId("retained-archive-content")).toBeNull();
});
