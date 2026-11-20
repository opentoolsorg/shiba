// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { UIMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StepTimeline } from "./StepTimeline";

const id = "file_0123456789abcdef01234567";
const generated = { ok: true, artifactId: id, title: "Weekly research", bytes: 120, downloadPath: "https://elsewhere.invalid/file" };
const report = { ...generated, kind: "report", mime: "text/markdown", sourceCount: 2 };
const page = { ...generated, kind: "page", title: "Project index", mime: "text/html", previewPath: "https://elsewhere.invalid/preview" };

function timeline(tool: string, output: unknown) {
  const messages = [{ id: "one", role: "assistant", parts: [{
    type: `tool-generate_${tool}`, toolCallId: "call", input: {}, state: "output-available", output,
  }] }] as UIMessage[];
  return render(<StepTimeline messages={messages} isStreaming={false} pendingApprovals={[]} decisions={{}} onDecideApproval={vi.fn()} />);
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("generated document messages", () => {
  it("fetches a report only on Read and renders text and web links without interpreting HTML", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(
      "# Findings\n\n<script>untrusted</script>\n\n**Summary** [Source](https://example.org/research) [Email](mailto:contact@example.org) [Relative](/private)",
    ));
    vi.stubGlobal("fetch", fetcher);
    timeline("report", report);
    expect(screen.getByRole("heading", { name: "Weekly research" })).toBeTruthy();
    expect(screen.getByText("2 sources")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Download" }).hasAttribute("download")).toBe(true);
    expect(screen.getByRole("link", { name: "Download" }).getAttribute("href")).toBe(`/api/files/${id}/download`);
    expect(fetcher).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Read report" }));
    const dialog = screen.getByRole("dialog", { name: "Weekly research" });
    expect(await within(dialog).findByText("<script>untrusted</script>")).toBeTruthy();
    expect(dialog.querySelector("script")).toBeNull();
    expect(dialog.querySelector("strong")?.textContent).toBe("Summary");
    expect(within(dialog).getAllByRole("link")).toHaveLength(1);
    expect(within(dialog).getByRole("link", { name: "Source" }).getAttribute("href")).toBe("https://example.org/research");
    expect(fetcher).toHaveBeenCalledWith(`/api/files/${id}/download`, expect.objectContaining({ credentials: "same-origin" }));
  });

  it("shows the loading and retry states and lets the reader recover", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValueOnce(new Response("Recovered report"));
    vi.stubGlobal("fetch", fetcher);
    timeline("report", report);
    fireEvent.click(screen.getByRole("button", { name: "Read report" }));
    expect(screen.getByRole("status").textContent).toContain("Loading report");
    expect((await screen.findByRole("alert")).textContent).toBe("Couldn’t load this report.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Recovered report")).toBeTruthy();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("uses the same sandboxed page in the transcript and the larger preview dialog", () => {
    timeline("page", page);
    const title = "Page preview: Project index";
    const inline = screen.getByTitle(title);
    fireEvent.click(screen.getByRole("button", { name: "Open preview" }));
    const dialog = screen.getByRole("dialog", { name: "Project index" });
    for (const frame of [inline, within(dialog).getByTitle(title)]) {
      expect(frame.tagName).toBe("IFRAME");
      expect(frame.getAttribute("src")).toBe(`/api/files/${id}/preview`);
      expect(frame.getAttribute("sandbox")).toBe("");
      expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
      expect(frame.getAttribute("loading")).toBe("lazy");
      expect(frame.hasAttribute("srcdoc")).toBe(false);
    }
    expect(screen.getByRole("link", { name: "Download" }).getAttribute("href")).toBe(`/api/files/${id}/download`);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getAllByTitle(title)).toHaveLength(1);
  });

  it.each([
    ["report", { ...report, artifactId: `${id}/other` }],
    ["page", { ...page, artifactId: "file_invalid" }],
    ["page", report],
    ["report", { ...report, sourceCount: -1 }],
    ["page", { ...page, mime: "text/plain" }],
  ] as const)("leaves malformed %s results as generic tool status", (tool, result) => {
    const { container } = timeline(tool, result);
    expect(screen.getByText(`Ran generate_${tool}`)).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
  });

  it.each(["page", "report"])("shows the %s failure as text", (tool) => {
    timeline(tool, { ok: false, error: "Could not save the document." });
    expect(screen.getByText("Could not save the document.")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("generated image messages", () => {
  it("shows the image from the validated file id and ignores a returned path", () => {
    const { container } = timeline("image", { ok: true, artifactId: id, downloadPath: "https://elsewhere.invalid/x.png", key: "files/ws/x.png" });
    expect(container.querySelector("img")?.getAttribute("src")).toBe(`/api/files/${id}/download`);
    expect(screen.getByRole("link", { name: "Download" }).getAttribute("href")).toBe(`/api/files/${id}/download`);
    expect(screen.queryByText(/files\/ws/)).toBeNull();
  });

  it("renders no image for a malformed id and shows a failure plainly", () => {
    const { container } = timeline("image", { ok: true, artifactId: "../../secret" });
    expect(container.querySelector("img")).toBeNull();
    cleanup();
    timeline("image", { ok: false, error: "Your image could not be created or saved. Please try again." });
    expect(screen.getByText("Your image could not be created or saved. Please try again.")).toBeTruthy();
  });
});

