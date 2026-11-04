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

  it("round-trips an explicitly chosen role and required outputs through a saved bot pack", async () => {
    let copied = "";
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async (value: string) => { copied = value; }) } });
    const request = vi.fn(async (_url: string, init?: RequestInit) => init?.method === "POST"
      ? Response.json({ agent: { id: "imported" } }, { status: 201 })
      : Response.json({ agents: [{ slug: "people-partner", config: { name: "People partner", roleTemplateId: "hr", instructions: "Draft only from approved policies.", harness: "codex", expectedDeliverables: ["hr/workflow.md"] } }] }));
    vi.stubGlobal("fetch", request);
    render(<AgentTemplatesCatalog onUse={vi.fn()} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Template category" }), { target: { value: "my" } });
    await screen.findByRole("heading", { name: /People partner/ });
    fireEvent.click(screen.getByRole("button", { name: "Copy pack" }));
    await waitFor(() => expect(copied).toContain('"roleTemplateId": "hr"'));
    fireEvent.click(screen.getByText("Paste import"));
    fireEvent.change(screen.getByLabelText("Template pack JSON"), { target: { value: copied } });
    fireEvent.click(screen.getByRole("button", { name: "Create bot from pack" }));
    await screen.findByText("People partner imported as a bot.");
    const write = request.mock.calls.find(([, init]) => init?.method === "POST");
    expect(write?.[0]).toBe("/api/custom-agents");
    expect(JSON.parse(String(write?.[1]?.body))).toEqual({ slug: "people-partner", config: {
      name: "People partner", roleTemplateId: "hr", instructions: "Draft only from approved policies.", harness: "codex", expectedDeliverables: ["hr/workflow.md"],
    } });
  });

  it("rejects a forged role identifier before creating an imported bot", async () => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    render(<AgentTemplatesCatalog onUse={vi.fn()} />);
    fireEvent.click(screen.getByText("Paste import"));
    fireEvent.change(screen.getByLabelText("Template pack JSON"), { target: { value: JSON.stringify({ template: { ...AGENT_TEMPLATES[0], roleTemplateId: "administrator" }, instructions: "Draft." }) } });
    fireEvent.click(screen.getByRole("button", { name: "Create bot from pack" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("roleTemplateId"));
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["denied", "unavailable"])("reports a copy error when clipboard access is %s", async (access) => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: access === "denied"
        ? { writeText: vi.fn().mockRejectedValue(new DOMException("Permission denied", "NotAllowedError")) }
        : undefined,
    });
    render(<AgentTemplatesCatalog onUse={async () => undefined} />);
    const copyButton = screen.getAllByRole("button", { name: "Copy pack" })[0];
    if (!copyButton) throw new Error("Expected a copy action.");

    fireEvent.click(copyButton);

    expect((await screen.findByRole("status")).textContent).toContain("Could not copy this pack. Check clipboard access and try again.");
    expect(screen.queryByText(/pack copied\./)).toBeNull();
  });
});
