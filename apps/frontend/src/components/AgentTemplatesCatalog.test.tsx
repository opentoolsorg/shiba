// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgentTemplatesCatalog } from "./AgentTemplatesCatalog";
import { AGENT_TEMPLATES } from "@shiba/shared";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("AgentTemplatesCatalog", () => {
  it("copies a JSON and Markdown pack and imports it through custom-agent creation", async () => {
    let copied = "";
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async (value: string) => { copied = value; }) } });
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ agent: { id: "new-agent" } }, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<AgentTemplatesCatalog onUse={async () => undefined} />);

    const copyButton = screen.getAllByRole("button", { name: "Copy pack" })[0];
    if (!copyButton) throw new Error("Expected a copy action.");
    fireEvent.click(copyButton);
    await waitFor(() => expect(copied).toContain("--- INSTRUCTIONS.md ---"));
    fireEvent.click(screen.getByText("Paste import"));
    fireEvent.change(screen.getByLabelText("Template pack JSON"), { target: { value: copied } });
    fireEvent.click(screen.getByRole("button", { name: "Create bot from pack" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const request = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(request[1].body)) as { slug: string; config: { name: string; instructions: string } };
    expect(request[0]).toBe("/api/custom-agents");
    expect(body.slug).toBe(AGENT_TEMPLATES[0]?.id);
    expect(body.config.instructions).toContain("approval must precede sandbox work");
  });

  it("uses a catalog template by creating a custom bot", async () => {
    const onUse = vi.fn().mockResolvedValue(undefined);
    render(<AgentTemplatesCatalog onUse={onUse} />);
    const useButton = screen.getAllByRole("button", { name: "Use" })[0];
    if (!useButton) throw new Error("Expected a use action.");
    fireEvent.click(useButton);
    await waitFor(() => expect(onUse).toHaveBeenCalledWith(AGENT_TEMPLATES[0]));
  });
});
