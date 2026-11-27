// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FilesView } from "./FilesView";

const file = {
  id: "file_0123456789abcdef01234567",
  name: "tracker.app-preview.json",
  scope: "personal",
  workspaceId: "self-hosted",
  mime: "application/json",
  size: 256,
  archivedAt: null as number | null,
  createdBy: "owner@example.test",
  ingestion: { state: "done" },
};
const path = `/api/files/${file.id}/app-preview`;
const sample = {
  specVersion: 1,
  title: "Mock tracker",
  description: "Mock data only.",
  columns: ["Title", "Value", "Done", "Notes"],
  rows: [
    ["Example", 12, false, null],
    ["<em>Plain text</em>", 4, true, "https://example.test/"],
  ],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function fixture(
  read: (signal?: AbortSignal | null) => Promise<Response> = async () =>
    Response.json({ preview: sample }),
  files = [file],
) {
  const preview = vi.fn(read);
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/api/files/folders?")) return Response.json({ folders: [] });
    if (url.startsWith("/api/files?")) return Response.json({ files });
    if (url === path) return preview(init?.signal);
    throw new Error("Unexpected request");
  });
  vi.stubGlobal("fetch", request);
  return { request, preview };
}

async function open() {
  const trigger = await screen.findByRole("button", { name: `Preview app: ${file.name}` });
  trigger.focus();
  fireEvent.click(trigger);
  return { trigger, dialog: await screen.findByRole("dialog", { name: "App preview" }) };
}

describe("private app preview in Files", () => {
  it("requests the fixed same-origin API only on open and renders an inert accessible table", async () => {
    let finish: (response: Response) => void = () => {};
    const { request, preview } = fixture(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<FilesView appPreviewOwner={file.createdBy} />);
    await screen.findByText(file.name);
    expect(preview).not.toHaveBeenCalled();
    const { trigger, dialog } = await open();
    expect(within(dialog).getByRole("status").textContent).toBe("Loading preview…");
    expect(request).toHaveBeenCalledWith(
      path,
      expect.objectContaining({
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(
      new Headers(request.mock.calls.find(([url]) => url === path)?.[1]?.headers).has(
        "X-Shiba-Workspace",
      ),
    ).toBe(false);
    expect(within(dialog).getByText("Private · Read-only. Nothing is saved.")).toBeTruthy();
    await act(async () => finish(Response.json({ preview: sample })));
    const table = await within(dialog).findByRole("table", { name: "Mock tracker data" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((item) => item.textContent),
    ).toEqual(sample.columns);
    expect(within(table).getByText("<em>Plain text</em>")).toBeTruthy();
    expect(table.querySelector("em, iframe, script, a, input")).toBeNull();
    expect(within(table).getByText("No")).toBeTruthy();
    expect(within(table).getByText("Yes")).toBeTruthy();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(preview).toHaveBeenCalledOnce();
  });

  it("keeps the action out of non-Access mode and ineligible file rows", async () => {
    const { preview } = fixture(undefined, [
      file,
      { ...file, id: "file_000000000000000000000001", name: "ordinary.json" },
      {
        ...file,
        id: "file_000000000000000000000002",
        name: "shared.app-preview.json",
        scope: "workspace",
      },
      {
        ...file,
        id: "file_000000000000000000000003",
        name: "team.app-preview.json",
        workspaceId: "ws_other",
      },
      { ...file, id: "invalid", name: "bad-id.app-preview.json" },
      {
        ...file,
        id: "file_000000000000000000000004",
        name: "html.app-preview.json",
        mime: "text/html",
      },
      {
        ...file,
        id: "file_000000000000000000000005",
        name: "archived.app-preview.json",
        archivedAt: 1,
      },
      {
        ...file,
        id: "file_000000000000000000000006",
        name: "other.app-preview.json",
        createdBy: "other@example.test",
      },
    ]);
    const view = render(<FilesView />);
    await screen.findByText(file.name);
    expect(screen.queryByRole("button", { name: /^Preview app:/ })).toBeNull();
    view.rerender(<FilesView appPreviewOwner={file.createdBy} />);
    expect(screen.getAllByRole("button", { name: /^Preview app:/ })).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Scope"), { target: { value: "workspace" } });
    expect(screen.queryByRole("button", { name: /^Preview app:/ })).toBeNull();
    expect(preview).not.toHaveBeenCalled();
  });

  it.each([
    [401, "Sign in with Cloudflare Access to open this preview."],
    [403, "This preview is unavailable to your account."],
    [404, "This preview is unavailable to your account."],
    [413, "This preview is larger than 64 KiB."],
    [422, "This file is not a valid app preview."],
  ])("handles HTTP %s without exposing the response body", async (status, message) => {
    fixture(async () => Response.json({ error: "opaque internal detail" }, { status }));
    render(<FilesView appPreviewOwner={file.createdBy} />);
    const { dialog } = await open();
    expect((await within(dialog).findByRole("alert")).textContent).toBe(message);
    expect(within(dialog).queryByText("opaque internal detail")).toBeNull();
    expect(within(dialog).queryByRole("table")).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("retries a transient or invalid response in the modal and handles an empty snapshot", async () => {
    const { preview } = fixture(async () => Response.json({ preview: { ...sample, rows: [] } }));
    preview.mockResolvedValueOnce(new Response(null, { status: 503 }));
    preview.mockResolvedValueOnce(
      Response.json({ preview: { ...sample, rows: [{ invalid: true }] } }),
    );
    render(<FilesView appPreviewOwner={file.createdBy} />);
    const { dialog } = await open();
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await within(dialog).findByText("Couldn’t load this preview.")).toBeTruthy();
      fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    }
    expect(await within(dialog).findByText("This snapshot has no rows.")).toBeTruthy();
    expect(preview).toHaveBeenCalledTimes(3);
  });

  it("aborts a closed preview and doesn't reuse its late result on reopening", async () => {
    let finish: (response: Response) => void = () => {};
    const { preview } = fixture(async () =>
      Response.json({ preview: { ...sample, title: "Fresh tracker" } }),
    );
    preview.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<FilesView appPreviewOwner={file.createdBy} />);
    const { dialog } = await open();
    const signal = preview.mock.calls[0]?.[0];
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(signal?.aborted).toBe(true);
    const current = (await open()).dialog;
    await within(current).findByRole("heading", { name: "Fresh tracker" });
    await act(async () => finish(Response.json({ preview: sample })));
    expect(within(current).queryByRole("heading", { name: "Mock tracker" })).toBeNull();
  });

  it("unmounts and aborts the preview when the owner changes", async () => {
    const { preview } = fixture(() => new Promise(() => {}));
    const view = render(<FilesView appPreviewOwner={file.createdBy} />);
    await open();
    const signal = preview.mock.calls[0]?.[0];
    view.rerender(<FilesView appPreviewOwner="other@example.test" />);
    expect(signal?.aborted).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("ends a timed-out preview with an inline retry", async () => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(timeout.signal);
    fixture(
      (signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    render(<FilesView appPreviewOwner={file.createdBy} />);
    const { dialog } = await open();
    expect(within(dialog).getByRole("status")).toBeTruthy();
    await act(async () => timeout.abort());
    expect(await within(dialog).findByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
