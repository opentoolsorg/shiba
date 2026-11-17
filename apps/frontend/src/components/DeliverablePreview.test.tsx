// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RunDeliverables } from "./RunDeliverables";
import { DeliverablePreview, parseCsv } from "./DeliverablePreview";

const file = (path: string, mediaType: string) => ({ path, mediaType, bytes: 10, sha256: "a".repeat(64), artifactId: `artifact_${"1".repeat(32)}`, version: 1 });
const CSV = "name,score\nb,10\na,2\n";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function stubFetch() {
  vi.stubGlobal("fetch", vi.fn(async (url: string) =>
    String(url).includes("/history") ? Response.json({ versions: [] }) : new Response(String(url).includes("/deliverables/1") ? CSV : "# Title\nbody")));
}
const renderAll = () => render(
  <RunDeliverables runId="run-1" status="completed"
    expected={["report.md", "data.csv", "dashboard.html", "report.pdf"]}
    deliverables={[file("report.md", "text/markdown"), file("data.csv", "text/csv"), file("dashboard.html", "text/html"), file("report.pdf", "application/pdf")]} />,
);

describe("deliverable previews", () => {
  it("renders md, csv, html and pdf variants", async () => {
    stubFetch();
    renderAll();
    await waitFor(() => expect(screen.getByText("Title")).toBeTruthy());
    await waitFor(() => expect(screen.getByRole("table")).toBeTruthy());
    expect(screen.getByTitle("Preview of dashboard.html")).toBeTruthy();
    expect(screen.getByTitle("Preview of report.pdf")).toBeTruthy();
    expect(screen.getByText("Open full screen")).toBeTruthy();
    expect(screen.getByText("Print / Save as PDF")).toBeTruthy();
    expect(screen.getAllByText("Share to room").length).toBeGreaterThan(0);
  });

  it("sandboxes the html frame without allow-same-origin", () => {
    stubFetch();
    renderAll();
    const frame = screen.getByTitle("Preview of dashboard.html");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.getAttribute("src")).toContain("inline=1");
  });

  it("renders Markdown and escapes raw HTML", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("# Report\n\n**Profit**\n\n<script>alert(1)</script>")));
    const { container } = render(<DeliverablePreview src="/report" path="report.md" />);
    await screen.findByText("Report");
    expect(screen.getByText("Profit").tagName).toBe("STRONG");
    expect(container.querySelector("script")).toBeNull();
  });

  it("sandboxes PDF frames and keeps a download fallback", () => {
    render(<DeliverablePreview src="/pdf" path="report.pdf" downloadHref="/pdf" />);
    expect(screen.getByTitle("Preview of report.pdf").getAttribute("sandbox")).toBe("");
    expect(screen.getByRole("link", { name: "Download PDF" }).getAttribute("href")).toBe("/pdf");
  });

  it("offers a download from shared CSV previews", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(CSV)));
    render(<DeliverablePreview src="/shared" path="data.csv" downloadHref="/shared" />);
    await screen.findByRole("table");
    expect(screen.getByRole("link", { name: "Download data.csv" }).getAttribute("href")).toBe("/shared");
  });

  it("sorts the csv table by column", async () => {
    stubFetch();
    renderAll();
    await waitFor(() => screen.getByRole("table"));
    fireEvent.click(screen.getByRole("button", { name: "score" }));
    const cells = screen.getAllByRole("row").slice(1).map((row) => row.textContent);
    expect(cells).toEqual(["a2", "b10"]);
  });

  it("parses quoted csv fields and caps rows", () => {
    expect(parseCsv('a,"b,""c"""\n1,2\n')).toEqual([["a", 'b,"c"'], ["1", "2"]]);
    expect(parseCsv(Array.from({ length: 900 }, (_, n) => `r${n}`).join("\n")).length).toBe(501);
  });
});
