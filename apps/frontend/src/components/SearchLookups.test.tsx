// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatLookupOptions, selectedChatLookups } from "../chat-lookups";
import { ChatMessageComposer } from "./ChatMessageComposer";
import { SearchSourcesCard, searchSources } from "./SearchSourcesCard";
import { StepTimeline } from "./StepTimeline";

afterEach(cleanup);

const setup = [
  { id: "web_search", label: "Web search", ready: true, env: "WEB_SEARCH_API_KEY" },
  { id: "knowledge_search", label: "Knowledge search", ready: false, env: "AGENT_AUDIT; AI; MEMORY_VECTORS" },
];

describe("chat lookup options", () => {
  it("only selects lookups the deployment can serve and names the missing env otherwise", () => {
    const options = chatLookupOptions(setup, ["web_search", "knowledge_search"]);
    expect(options).toMatchObject([
      { id: "web_search", on: true, available: true },
      { id: "knowledge_search", on: false, available: false, unavailableReason: "Not configured on this deployment (AGENT_AUDIT; AI; MEMORY_VECTORS)." },
    ]);
    expect(selectedChatLookups(options)).toEqual(["web_search"]);
    expect(selectedChatLookups(chatLookupOptions(null, ["knowledge_search"]))).toEqual(["knowledge_search"]);
  });
});

describe("ChatMessageComposer lookups", () => {
  const props = { value: "", onChange: vi.fn(), onSubmit: vi.fn(), onStop: vi.fn(), onRetry: vi.fn(), busy: false, failed: false };

  it("toggles a lookup for the next message and reports it in the mode label", () => {
    const onToggleLookup = vi.fn();
    const view = render(<ChatMessageComposer {...props} streaming={false} lookups={chatLookupOptions(setup, [])} onToggleLookup={onToggleLookup} />);
    const group = screen.getByRole("group", { name: "Lookups for this message" });
    const web = within(group).getByRole("button", { name: "Web" });
    expect(web.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("CHAT MODE")).toBeTruthy();
    fireEvent.click(web);
    expect(onToggleLookup).toHaveBeenCalledWith("web_search");
    view.rerender(<ChatMessageComposer {...props} streaming={false} lookups={chatLookupOptions(setup, ["web_search"])} onToggleLookup={onToggleLookup} />);
    expect(within(group).getByRole("button", { name: "Web" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("CHAT MODE · WEB LOOKUP")).toBeTruthy();
  });

  it("disables an unconfigured lookup with the reason, and every lookup while streaming", () => {
    const view = render(<ChatMessageComposer {...props} streaming={false} lookups={chatLookupOptions(setup, [])} onToggleLookup={vi.fn()} />);
    const knowledge = screen.getByRole("button", { name: "Knowledge" }) as HTMLButtonElement;
    expect(knowledge.disabled).toBe(true);
    expect(knowledge.title).toContain("MEMORY_VECTORS");
    view.rerender(<ChatMessageComposer {...props} streaming lookups={chatLookupOptions(setup, [])} onToggleLookup={vi.fn()} />);
    expect((screen.getByRole("button", { name: "Web" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders no lookup controls without a toggle handler", () => {
    render(<ChatMessageComposer {...props} streaming={false} lookups={chatLookupOptions(setup, [])} />);
    expect(screen.queryByRole("group", { name: "Lookups for this message" })).toBeNull();
  });
});

describe("SearchSourcesCard", () => {
  it("lists web sources as safe external links and drops non-https URLs", () => {
    render(<SearchSourcesCard tool="web_search" output={{ ok: true, results: [
      { title: "Workers pricing", url: "https://www.cloudflare.com/pricing", snippet: "Free tier", query: "pricing" },
      { title: "Bad", url: "javascript:alert(1)", snippet: "x" },
    ] }} />);
    const card = screen.getByRole("region", { name: "Web sources" });
    const link = within(card).getByRole("link", { name: "Workers pricing" });
    expect(link.getAttribute("href")).toBe("https://www.cloudflare.com/pricing");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(within(card).getByText("cloudflare.com")).toBeTruthy();
    expect(within(card).queryByText("Bad")).toBeNull();
  });

  it("lists knowledge passages by source name and scope", () => {
    render(<SearchSourcesCard tool="knowledge_search" output={{ ok: true, query: "launch", hits: [
      { chunkId: "c1", sourceKind: "file", sourceName: "launch-plan.md", scope: "workspace", text: "Falcon ships in March." },
    ] }} />);
    const card = screen.getByRole("region", { name: "Knowledge sources" });
    expect(within(card).getByText("launch-plan.md")).toBeTruthy();
    expect(within(card).getByText("File · Workspace")).toBeTruthy();
    expect(within(card).queryByRole("link")).toBeNull();
  });

  it("shows the backend's honest message when a lookup is unavailable or empty", () => {
    expect(searchSources("web_search", { ok: false, unavailable: true, message: "Web search is not configured on this deployment." }))
      .toEqual({ sources: [], message: "Web search is not configured on this deployment." });
    expect(searchSources("knowledge_search", { ok: true, hits: [] })?.message).toBe("No matching files or notes.");
    expect(searchSources("generate_image", { ok: true })).toBeNull();
  });
});

describe("StepTimeline lookup results", () => {
  it("renders a completed web_search call as a sources card instead of raw JSON", () => {
    render(<StepTimeline
      messages={[{ id: "a1", role: "assistant", parts: [{
        type: "tool-web_search", toolCallId: "call-1", state: "output-available",
        input: { query: "workers pricing" },
        output: { ok: true, results: [{ title: "Workers pricing", url: "https://www.cloudflare.com/pricing", snippet: "Free tier" }] },
      }] }] as never}
      isStreaming={false}
      pendingApprovals={[]}
      decisions={{}}
      onDecideApproval={vi.fn()}
    />);
    expect(screen.getByRole("region", { name: "Web sources" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Workers pricing" })).toBeTruthy();
    expect(screen.queryByText("Output")).toBeNull();
  });
});
