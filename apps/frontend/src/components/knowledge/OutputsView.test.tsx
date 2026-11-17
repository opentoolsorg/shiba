// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutputsView } from "./OutputsView";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const image = { id: "image-1", kind: "output", title: "Generated image.jpg", mime: "image/jpeg", downloadPath: "/api/files/image-1/download", createdAt: 1730000000000, media: { kind: "image", mode: "text-to-image", label: "Lucid Origin", aspectRatio: "16:9", prompt: "A coastal town at sunrise" } };
function api(items: unknown[] = [image], fail = false) {
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/media-options")) return Response.json({ imageModels: [{ id: "flux", label: "Flux Schnell", supportsDimensions: false }, { id: "lucid", label: "Lucid Origin", supportsDimensions: true }], imageAspectRatios: ["1:1", "16:9"] });
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
    fireEvent.click(screen.getByRole("button", { name: "Videos", exact: true }));
    await waitFor(() => expect(mock).toHaveBeenCalledWith("/api/outputs?type=video", expect.anything()));
    fireEvent.change(screen.getByLabelText("Shape"), { target: { value: "16:9" } });
    expect(screen.queryByRole("option", { name: "Flux Schnell" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Describe your image"), { target: { value: "A mountain" } });
    fireEvent.change(screen.getByLabelText("Style"), { target: { value: "lucid" } });
    fireEvent.click(screen.getByRole("button", { name: "Create image", exact: true }));
    await waitFor(() => expect(mock).toHaveBeenCalledWith("/api/outputs/images", expect.objectContaining({ method: "POST", body: JSON.stringify({ prompt: "A mountain", model: "lucid", aspectRatio: "16:9" }) })));
    await waitFor(() => expect(mock).toHaveBeenCalledWith("/api/outputs?type=image", expect.anything()));
  });
  it("shows the empty state and a recoverable generation error", async () => {
    api([], true);
    render(<OutputsView />);
    expect(await screen.findByText("No outputs yet")).toBeTruthy();
    await screen.findByRole("option", { name: "Lucid Origin" });
    fireEvent.change(screen.getByLabelText("Describe your image"), { target: { value: "A mountain" } });
    fireEvent.click(screen.getByRole("button", { name: "Create image", exact: true }));
    expect(await screen.findByText("Please try another description.")).toBeTruthy();
  });
});
