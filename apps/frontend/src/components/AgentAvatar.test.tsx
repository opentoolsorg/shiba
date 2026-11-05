// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { EmployeeRole } from "../employee-templates";
import { AgentAvatar } from "./AgentAvatar";

afterEach(cleanup);

describe("AgentAvatar", () => {
  it("renders a deterministic mascot with alt text", () => {
    const { rerender } = render(<AgentAvatar id="coding-coworker" name="Coder" />);
    const first = screen.getByRole("img", { name: "Coder" }).getAttribute("src");
    expect(first).toBe("/assets/agents/agni.png");
    rerender(<AgentAvatar id="coding-coworker" name="Coder" />);
    expect(screen.getByRole("img", { name: "Coder" }).getAttribute("src")).toBe(first);
  });

  it("falls back to a stable mascot for unknown ids", () => {
    render(<AgentAvatar id="zzz-unknown" name="Zed" />);
    expect(screen.getByRole("img", { name: "Zed" }).getAttribute("src")).toMatch(/^\/assets\/agents\/[a-z]+\.png$/);
  });

  it("maps a role to its landing-cast mascot and exposes the role", () => {
    const design: EmployeeRole = "design";
    const { container } = render(<AgentAvatar id="custom-1" name="Designer" role={design} />);
    expect(screen.getByRole("img", { name: "Designer" }).getAttribute("src")).toBe("/assets/agents/vishwa.png");
    expect(container.querySelector('[data-employee-role="design"]')).toBeTruthy();
  });

  it("shows initials when the image fails", () => {
    render(<AgentAvatar id="x" name="Ada Lovelace" />);
    fireEvent.error(screen.getByRole("img", { name: "Ada Lovelace" }));
    expect(screen.getByText("AL")).toBeTruthy();
  });

  it("renders a status dot and size", () => {
    const { container } = render(<AgentAvatar id="x" name="Zed" size={64} status="working" />);
    expect(screen.getByRole("img", { name: "working" })).toBeTruthy();
    expect((container.firstChild as HTMLElement).style.width).toBe("64px");
  });

  it("is decorative when requested", () => {
    const { container } = render(<AgentAvatar id="x" name="Zed" decorative />);
    expect(container.querySelector("img")?.getAttribute("alt")).toBe("");
  });
});
