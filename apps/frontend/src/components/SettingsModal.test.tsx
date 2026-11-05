// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SettingsModal } from "./SettingsModal";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SettingsModal", () => {
  it("renders nothing when isOpen is false", () => {
    const { container } = render(<SettingsModal isOpen={false} onClose={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the modal dialog with SettingsPanel and SettingsPage when open", () => {
    const fetcher = vi.fn(async () => Response.json({ agent: "test@example.com", auth: "none" }));
    vi.stubGlobal("fetch", fetcher);

    const onClose = vi.fn();
    render(<SettingsModal isOpen onClose={onClose} initialSection="account" />);

    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeTruthy();

    // Escape closes modal
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
