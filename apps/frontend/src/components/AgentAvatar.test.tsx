// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EmployeeRole } from "../employee-templates";
import { AgentAvatar } from "./AgentAvatar";

afterEach(cleanup);

function face(name: string): HTMLElement {
  const node = screen.getByRole("img", { name }).closest(".agent-avatar")?.querySelector(".shiba-agent-mascot");
  return node as HTMLElement;
}

describe("AgentAvatar", () => {
  it("uses the real Shiba portrait by default", () => {
    render(<AgentAvatar id="coding-coworker" name="Coder" />);
    expect(document.querySelector(".agent-avatar img")?.getAttribute("src")).toBe("/assets/mascot/pet-logo.png");
  });

  it("preserves uploaded portraits over the default Shiba", () => {
    render(<AgentAvatar id="coding-coworker" name="Coder" imageSrc="/custom.png" />);
    expect(document.querySelector(".agent-avatar img")?.getAttribute("src")).toBe("/custom.png");
  });

  it("keeps an explicitly customized mascot preset or look", () => {
    const { rerender } = render(<AgentAvatar id="coding-coworker" name="Coder" mascotPreset="sleeping" />);
    expect(face("Coder").getAttribute("data-eyes")).toBe("sleepy");
    rerender(<AgentAvatar id="coding-coworker" name="Coder" look={{ shape: "bean", color: "#6e8b6a", eyes: "wink", acc: "headset" }} />);
    expect(face("Coder").getAttribute("data-shape")).toBe("bean");
    expect(face("Coder").getAttribute("data-eyes")).toBe("wink");
  });

  it("maps a role to its default look and exposes the role", () => {
    const design: EmployeeRole = "design";
    const { container } = render(<AgentAvatar id="custom-1" name="Designer" role={design} />);
    expect(face("Designer").getAttribute("data-shape")).toBe("pointed");
    expect(face("Designer").getAttribute("data-eyes")).toBe("star");
    expect(face("Designer").getAttribute("data-acc")).toBe("pen");
    expect(container.querySelector('[data-employee-role="design"]')).toBeTruthy();
  });

  it("uses a saved preset, then a saved look", () => {
    const { rerender } = render(<AgentAvatar id="coding-coworker" name="Coder" mascotPreset="sleeping" />);
    expect(face("Coder").getAttribute("data-eyes")).toBe("sleepy");
    expect(face("Coder").getAttribute("data-acc")).toBe("coffee");
    rerender(<AgentAvatar id="coding-coworker" name="Coder" mascotPreset="riding" look={{ shape: "bean", color: "#6e8b6a", eyes: "wink", acc: "headset" }} />);
    expect(face("Coder").getAttribute("data-shape")).toBe("bean");
    expect(face("Coder").getAttribute("data-eyes")).toBe("wink");
    expect(face("Coder").getAttribute("data-acc")).toBe("headset");
  });

  it("falls back to initials when an uploaded image fails", () => {
    render(<AgentAvatar id="x" name="Ada Lovelace" imageSrc="/portrait.png" />);
    fireEvent.error(screen.getByRole("img", { name: "Ada Lovelace" }));
    expect(screen.getByText("AL")).toBeTruthy();
  });

  it("maps status onto the live expression and keeps the status dot", () => {
    const { container, rerender } = render(<AgentAvatar id="x" name="Zed" size={64} status="working" look={{ shape: "round", color: "#ab7654", eyes: "happy", acc: "none" }} />);
    expect(screen.getByRole("img", { name: "working" })).toBeTruthy();
    expect(face("Zed").getAttribute("data-expression")).toBe("code");
    expect(face("Zed").getAttribute("data-live")).toBe("true");
    expect((container.firstChild as HTMLElement).style.width).toBe("64px");
    rerender(<AgentAvatar id="x" name="Zed" size={64} status="waiting" look={{ shape: "round", color: "#ab7654", eyes: "happy", acc: "none" }} />);
    expect(face("Zed").getAttribute("data-expression")).toBe("sleepy");
    rerender(<AgentAvatar id="x" name="Zed" size={64} status="needs-approval" look={{ shape: "round", color: "#ab7654", eyes: "happy", acc: "none" }} />);
    expect(face("Zed").getAttribute("data-expression")).toBe("surprised");
    rerender(<AgentAvatar id="x" name="Zed" size={64} status="idle" live={false} look={{ shape: "round", color: "#ab7654", eyes: "happy", acc: "none" }} />);
    expect(face("Zed").getAttribute("data-live")).toBe("false");
  });

  it("keeps the default portrait decorative when requested", () => {
    const { container } = render(<AgentAvatar id="x" name="Zed" decorative />);
    expect(container.querySelector(".agent-avatar img")?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(".agent-avatar img")?.getAttribute("alt")).toBe("");
  });

  it("gates blink motion on prefers-reduced-motion", () => {
    const css = readFileSync(resolve(import.meta.dirname, "../styles.css"), "utf8");
    expect(css).toContain('@media (prefers-reduced-motion: no-preference)');
    expect(css).toContain(".shiba-agent-mascot[data-live=\"true\"] .shiba-mascot-blink");
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });
});
