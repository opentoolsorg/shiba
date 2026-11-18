// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AssistantContextImport, CONTEXT_IMPORT_PROMPT } from "./AssistantContextImport";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("AssistantContextImport", () => {
  it("copies the brief prompt and keeps Save disabled until there is a reply", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<AssistantContextImport onImported={vi.fn()} />);
    expect(screen.getByTestId("context-import-prompt").textContent).toBe(CONTEXT_IMPORT_PROMPT);
    expect(CONTEXT_IMPORT_PROMPT).toMatch(/Leave out passwords, keys/);
    fireEvent.click(screen.getByRole("button", { name: "Copy prompt" }));
    await screen.findByRole("button", { name: "Copied" });
    expect(writeText).toHaveBeenCalledWith(CONTEXT_IMPORT_PROMPT);
    expect((screen.getByRole("button", { name: "Save context" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("posts the chosen assistant and trimmed reply, then reports the saved source", async () => {
    const source = { id: "memsrc_" + "1".repeat(24), title: "Context from Gemini" };
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ source, redacted: 2 }) }));
    vi.stubGlobal("fetch", fetchMock);
    const onImported = vi.fn();
    render(<AssistantContextImport onImported={onImported} />);
    fireEvent.click(screen.getByRole("radio", { name: "Gemini" }));
    expect(screen.getByText("Ask Gemini this")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Paste its reply" }), { target: { value: "  Facts about me  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save context" }));
    await waitFor(() => expect(onImported).toHaveBeenCalledWith(source, 2));
    expect(fetchMock).toHaveBeenCalledWith("/api/memory/sources/import", expect.objectContaining({
      method: "POST", credentials: "same-origin", body: JSON.stringify({ assistant: "gemini", content: "Facts about me" }),
    }));
    expect((screen.getByRole("textbox", { name: "Paste its reply" }) as HTMLTextAreaElement).value).toBe("");
  });

  it("keeps the reply and shows the server's reason when saving fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({ error: "Only plain TXT or Markdown without binary content or active markup is supported." }) })));
    const onImported = vi.fn();
    render(<AssistantContextImport onImported={onImported} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Paste its reply" }), { target: { value: "<b>hi</b>" } });
    fireEvent.click(screen.getByRole("button", { name: "Save context" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/active markup/);
    expect(onImported).not.toHaveBeenCalled();
    expect((screen.getByRole("textbox", { name: "Paste its reply" }) as HTMLTextAreaElement).value).toBe("<b>hi</b>");
  });
});
