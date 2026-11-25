// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { AGENT_TEMPLATES } from "@shiba/shared";
import { TemplateDetailDialog } from "./TemplateDetailDialog";

afterEach(cleanup);

const coding = AGENT_TEMPLATES.find((item) => item.id === "coding-coworker") ?? AGENT_TEMPLATES[0];
const plain = AGENT_TEMPLATES.find((item) => item.skills.length + item.plugins.length === 0) ?? AGENT_TEMPLATES[0];
if (!coding || !plain || coding.skills.length === 0) throw new Error("Expected a template with and without recommendations.");
const props = () => ({ busy: false, message: "", onHire: vi.fn(), onCopy: vi.fn(), onClose: vi.fn() });

describe("TemplateDetailDialog", () => {
  it("shows description, instructions, capabilities and not-installed recommendations", () => {
    render(<TemplateDetailDialog template={coding} {...props()} />);
    const dialog = screen.getByRole("dialog", { name: coding.name });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const view = within(dialog);
    expect(view.getByText(coding.description)).toBeTruthy();
    expect(view.getByText(coding.instructions.slice(0, 40), { exact: false })).toBeTruthy();
    expect(view.getByText("Provider: opencode")).toBeTruthy();
    expect(view.getByText("Slack threads")).toBeTruthy();
    expect(view.getByText("Approval-gated")).toBeTruthy();
    expect(view.getByText("Recommended, not installed")).toBeTruthy();
    expect(view.getByText("repository work")).toBeTruthy();
    expect(view.getByText("Not included: credentials, network access, or external permissions")).toBeTruthy();
    expect(dialog.textContent).not.toMatch(/verified|rating|installs|downloads|published by/i);
  });

  it("says so when a template recommends no skills or plugins", () => {
    render(<TemplateDetailDialog template={plain} {...props()} />);
    expect(screen.getByText("None recommended for this template.")).toBeTruthy();
  });

  it("wires Hire, Copy pack and Close to the caller and offers nothing else", () => {
    const handlers = props();
    render(<TemplateDetailDialog template={coding} {...handlers} />);
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["Close", "Hire ", "Copy pack"]);
    fireEvent.click(screen.getByRole("button", { name: "Hire" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy pack" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(handlers.onHire).toHaveBeenCalledOnce();
    expect(handlers.onCopy).toHaveBeenCalledOnce();
    expect(handlers.onClose).toHaveBeenCalledOnce();
  });

  it("disables Hire while busy and announces the caller's message", () => {
    render(<TemplateDetailDialog template={coding} {...props()} busy message="Coding Coworker pack copied." />);
    expect((screen.getByRole("button", { name: "Hire" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toBe("Coding Coworker pack copied.");
  });

  it("focuses inside on open, closes on Escape, traps Tab, and returns focus to the opener", () => {
    const handlers = props();
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const { unmount } = render(<TemplateDetailDialog template={coding} {...handlers} />);
    const close = screen.getByRole("button", { name: "Close" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Copy pack" }));
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(handlers.onClose).toHaveBeenCalledOnce();
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
