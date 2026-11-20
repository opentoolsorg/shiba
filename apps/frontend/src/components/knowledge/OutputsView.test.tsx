// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readPromptParam } from "../../ui-helpers";
import { OutputsView } from "./OutputsView";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const image = { id: "image-1", kind: "output", title: "Generated image.jpg", mime: "image/jpeg", downloadPath: "/api/files/image-1/download", createdAt: 1730000000000, media: { kind: "image", mode: "text-to-image", label: "Lucid Origin", aspectRatio: "16:9", prompt: "A coastal town at sunrise" } };
const report = { id: `file_${"a".repeat(24)}`, kind: "output", documentKind: "report", mime: "text/markdown", title: "Field notes.md", downloadPath: "/not-a-file", createdAt: 1730000000000 };
const page = { ...report, id: `file_${"b".repeat(24)}`, documentKind: "page", mime: "text/html", title: "Field guide.html" };
const videoOff = { enabled: false, reason: "Connect a Google API key in Settings → Providers to generate videos.", modes: [], aspectRatios: [] };
const videoOn = { enabled: true, reason: null, modes: ["text-to-video"], aspectRatios: ["16:9", "9:16", "1:1"] };
function api(items: unknown[] = [image], fail = false, video: unknown = videoOff) {
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/media-options")) return Response.json({ imageModels: [{ id: "flux", label: "Flux Schnell", supportsDimensions: false }, { id: "lucid", label: "Lucid Origin", supportsDimensions: true }], imageAspectRatios: ["1:1", "16:9"], video });
    if (init?.method === "POST") return fail ? Response.json({ error: "Please try another description." }, { status: 400 }) : Response.json({ ok: true });
    return Response.json({ items });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}
describe("Outputs gallery", () => {
  it("lists documents without loading their contents and opens a page preview on demand", async () => {
    const mock = api([report, page]);
    const { container } = render(<OutputsView />);
    fireEvent.click(screen.getByRole("button", { name: "Documents" }));
    expect(await screen.findByText("Report")).toBeTruthy();
    expect(screen.getByText("Web page")).toBeTruthy();
    expect(mock).toHaveBeenCalledWith("/api/outputs?type=document", expect.anything());
    expect(screen.getByRole("button", { name: /^Read\b/i })).toBeTruthy();
    expect(screen.getAllByRole("link", { name: /Download/i }).map((a) => a.getAttribute("href"))).toEqual([
      `/api/files/${report.id}/download`, `/api/files/${page.id}/download`,
    ]);
    expect(mock.mock.calls.some(([url]) => url.startsWith("/api/files/"))).toBe(false);
    expect(container.querySelector("iframe")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Preview/i }));
    const preview = await screen.findByTitle(`Page preview: ${page.title}`);
    expect(preview.getAttribute("src")).toBe(`/api/files/${page.id}/preview`);
    expect(preview.getAttribute("sandbox")).toBe("");
  });

  it("does not use an invalid document's download path as a link or a media preview", async () => {
    api([
      { ...report, id: "file_invalid" },
      { ...page, documentKind: "report" },
      { ...page, id: `file_${"c".repeat(24)}`, mime: "image/png" },
      { ...report, id: `file_${"d".repeat(24)}`, documentKind: undefined },
      { ...report, id: `file_${"e".repeat(24)}`, documentKind: undefined, mime: "image/jpeg" },
    ]);
    const { container } = render(<OutputsView />);
    fireEvent.click(screen.getByRole("button", { name: "Documents" }));
    expect(await screen.findAllByText("Document unavailable")).toHaveLength(5);
    expect(container.querySelector("a, iframe, img, video")).toBeNull();
    expect(screen.queryByRole("button", { name: /^(Read|Preview)\b/ })).toBeNull();
  });

  it("ignores an earlier filter's error after the Documents list loads", async () => {
    let failVideoRequest!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { failVideoRequest = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/outputs?type=video") return pending;
      if (url.endsWith("/media-options")) return Response.json({ imageModels: [] });
      return Response.json({ items: url === "/api/outputs" ? [image] : [report] });
    }));
    render(<OutputsView />);
    await screen.findByAltText(image.media.prompt);
    fireEvent.click(screen.getByRole("button", { name: "Videos" }));
    expect(screen.queryByAltText(image.media.prompt)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Documents" }));
    await screen.findByText(report.title);
    await act(async () => failVideoRequest(Response.json({ error: "Stale filter error" }, { status: 503 })));
    expect(screen.queryByText("Stale filter error")).toBeNull();
    expect(screen.getByText(report.title)).toBeTruthy();
  });
  it("renders previews, plain-language metadata, descriptions and deliverables", async () => {
    api([image, { ...image, id: "video", mime: "video/mp4", title: "A clip", media: { ...image.media, mode: "image-to-video", durationSeconds: 8 } }, { ...image, id: "archive", title: "Run 1", kind: "run-deliverable", mime: "application/zip", media: undefined }]);
    const { container } = render(<OutputsView />);
    expect(await screen.findByAltText("A coastal town at sunrise")).toBeTruthy();
    expect(screen.getByText("Made with Lucid Origin · 16:9 · 8 sec · Animated from an image")).toBeTruthy();
    expect(container.querySelector("video[controls]")).toBeTruthy();
    expect(container.querySelector("details summary")?.textContent).toBe(image.media.prompt);
    expect(screen.getByText("Run deliverable")).toBeTruthy();
    expect(screen.queryByText("image/jpeg")).toBeNull();
    expect(screen.getAllByRole("link", { name: "Download" })).toHaveLength(3);
  });
  it("filters media, hides square-only styles for wide shapes, and creates an image", async () => {
    const mock = api();
    render(<OutputsView />);
    await screen.findByRole("option", { name: "Flux Schnell" });
    fireEvent.click(screen.getByRole("button", { name: "Videos" }));
    await waitFor(() => expect(mock).toHaveBeenCalledWith("/api/outputs?type=video", expect.anything()));
    fireEvent.change(screen.getByLabelText("Shape"), { target: { value: "16:9" } });
    expect(screen.queryByRole("option", { name: "Flux Schnell" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Describe your image"), { target: { value: "A mountain" } });
    fireEvent.change(screen.getByLabelText("Style"), { target: { value: "lucid" } });
    fireEvent.click(screen.getByRole("button", { name: "Create image" }));
    await waitFor(() => expect(mock).toHaveBeenCalledWith("/api/outputs/images", expect.objectContaining({ method: "POST", body: JSON.stringify({ prompt: "A mountain", model: "lucid", aspectRatio: "16:9" }) })));
    await waitFor(() => expect(mock).toHaveBeenCalledWith("/api/outputs?type=image", expect.anything()));
  });
  it("shows the empty state and a recoverable generation error", async () => {
    api([], true);
    render(<OutputsView />);
    expect(await screen.findByText("No outputs yet")).toBeTruthy();
    await screen.findByRole("option", { name: "Lucid Origin" });
    fireEvent.change(screen.getByLabelText("Describe your image"), { target: { value: "A mountain" } });
    fireEvent.click(screen.getByRole("button", { name: "Create image" }));
    expect(await screen.findByText("Please try another description.")).toBeTruthy();
  });
  it("hands video creation to an unsent Chat draft without generating or approving anything", async () => {
    const mock = api([image], false, videoOn);
    render(<OutputsView />);
    const link = await screen.findByRole("link", { name: "Create in Chat" });
    fireEvent.change(screen.getByLabelText("Video shape"), { target: { value: "9:16" } });
    const href = new URL(link.getAttribute("href") ?? "", "https://shiba.test");
    expect(href.pathname).toBe("/threads/");
    expect(readPromptParam(href.search)).toEqual({ prompt: "Create a 9:16 video of ", nextSearch: "", createVideo: true });
    expect(screen.getByText(/nothing is generated until you approve it/)).toBeTruthy();
    expect(mock.mock.calls.map(([url, init]) => [url, init?.method ?? "GET"])).toEqual(expect.arrayContaining([["/api/outputs/media-options", "GET"]]));
    expect(mock.mock.calls.every(([url, init]) => (init?.method ?? "GET") === "GET" && /^\/api\/outputs(\?|\/media-options$|$)/.test(url))).toBe(true);
  });
  it("disables the Chat handoff with the server's reason when video is unavailable", async () => {
    const mock = api([image], false, videoOff);
    render(<OutputsView />);
    const button = await screen.findByRole("button", { name: "Create in Chat" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute("aria-describedby")).toBe("outputs-video-reason");
    expect(screen.getByText(videoOff.reason)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Create in Chat" })).toBeNull();
    expect(screen.queryByLabelText("Video shape")).toBeNull();
    fireEvent.click(button);
    expect(mock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });
  it("keeps the handoff disabled when media options cannot load", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/media-options") ? Response.json({ error: "down" }, { status: 503 }) : Response.json({ items: [] })));
    render(<OutputsView />);
    expect(await screen.findByText("Video options could not be loaded. Refresh the page to try again.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Create in Chat" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("heading", { name: "Create an image" })).toBeNull();
  });
});
