// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EmployeeRole } from "../employee-templates";
import { AgentAvatar } from "./AgentAvatar";

afterEach(cleanup);

function face(name: string): HTMLElement {
  const node = screen.getByRole("img", { name }).querySelector(".shiba-agent-mascot") ?? screen.getByRole("img", { name });
  return node as HTMLElement;
}

describe("AgentAvatar", () => {
  it("renders a deterministic visor mascot for a catalog teammate", () => {
    const { rerender } = render(<AgentAvatar id="coding-coworker" name="Coder" />);
    const first = face("Coder");
    expect(first.getAttribute("data-shape")).toBe("pointed");
    expect(first.getAttribute("data-eyes")).toBe("happy");
    expect(first.getAttribute("data-expression")).toBe("happy");
    expect(first.getAttribute("data-live")).toBe("true");
    rerender(<AgentAvatar id="coding-coworker" name="Coder" />);
    expect(face("Coder").getAttribute("data-color")).toBe(first.getAttribute("data-color"));
  });

  it("gives unknown ids a stable hashed face", () => {
    const { rerender, unmount } = render(<AgentAvatar id="zzz-unknown" name="Zed" />);
    const first = ["data-shape", "data-color", "data-eyes", "data-acc"].map((attr) => face("Zed").getAttribute(attr)).join("|");
    rerender(<AgentAvatar id="zzz-unknown" name="Zed" />);
    expect(["data-shape", "data-color", "data-eyes", "data-acc"].map((attr) => face("Zed").getAttribute(attr)).join("|")).toBe(first);
    unmount();
    render(<AgentAvatar id="yyy-unknown" name="Yan" />);
    const second = ["data-shape", "data-color", "data-eyes", "data-acc"].map((attr) => face("Yan").getAttribute(attr)).join("|");
    expect(second).not.toBe(first);
  });

  it("maps a role to its default look and exposes the role", () => {
    const design: EmployeeRole = "design";
    const { container } = render(<AgentAvatar id="custom-1" name="Designer" role={design} />);
    expect(face("Designer").getAttribute("data-shape")).toBe("cloud");
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
    const { container, rerender } = render(<AgentAvatar id="x" name="Zed" size={64} status="working" />);
    expect(screen.getByRole("img", { name: "working" })).toBeTruthy();
    expect(face("Zed").getAttribute("data-expression")).toBe("code");
    expect(face("Zed").getAttribute("data-live")).toBe("true");
    expect((container.firstChild as HTMLElement).style.width).toBe("64px");
    rerender(<AgentAvatar id="x" name="Zed" size={64} status="waiting" />);
    expect(face("Zed").getAttribute("data-expression")).toBe("sleepy");
    rerender(<AgentAvatar id="x" name="Zed" size={64} status="needs-approval" />);
    expect(face("Zed").getAttribute("data-expression")).toBe("surprised");
    rerender(<AgentAvatar id="x" name="Zed" size={64} status="idle" live={false} />);
    expect(face("Zed").getAttribute("data-live")).toBe("false");
  });

  it("is decorative when requested", () => {
    const { container } = render(<AgentAvatar id="x" name="Zed" decorative />);
    const mascot = container.querySelector(".shiba-agent-mascot");
    expect(mascot?.getAttribute("aria-hidden")).toBe("true");
    expect(mascot?.getAttribute("role")).toBeNull();
  });

  it("gates blink motion on prefers-reduced-motion", () => {
    const css = readFileSync(resolve(import.meta.dirname, "../styles.css"), "utf8");
    expect(css).toContain('@media (prefers-reduced-motion: no-preference)');
    expect(css).toContain(".shiba-agent-mascot[data-live=\"true\"] .shiba-mascot-blink");
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });
});
