// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readPromptParam } from "../../ui-helpers";
import { OutputsView } from "./OutputsView";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const image = { id: "image-1", kind: "output", title: "Generated image.jpg", mime: "image/jpeg", downloadPath: "/api/files/image-1/download", createdAt: 1730000000000, media: { kind: "image", mode: "text-to-image", label: "Lucid Origin", aspectRatio: "16:9", prompt: "A coastal town at sunrise" } };
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
    expect(readPromptParam(href.search)).toEqual({ prompt: "Create a 9:16 video of ", nextSearch: "" });
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
