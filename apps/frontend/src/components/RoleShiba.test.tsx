// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EMPLOYEE_TEMPLATES, employeeRole } from "../employee-templates";
import { RoleShiba } from "./RoleShiba";

afterEach(cleanup);

describe("original role Shibas", () => {
  it.each(EMPLOYEE_TEMPLATES)("resolves $label from its exact template slug", (template) => {
    expect(employeeRole(template.slug)).toBe(template.id);
    render(<RoleShiba slug={template.slug} />);
    const avatar = screen.getByRole("img", { name: `${template.label} Shiba` });
    expect(avatar.getAttribute("data-employee-role")).toBe(template.id);
    expect(avatar.getAttribute("viewBox")).toBe("0 0 64 64");
  });

  it.each([undefined, "", "engineering", "Engineering-bot", "research-bot-copy", "opencode", "claude-code", "codex", "__proto__"])("uses a safe custom identity for %s", (slug) => {
    expect(employeeRole(slug)).toBe("custom");
    render(<RoleShiba slug={slug} />);
    expect(screen.getByRole("img", { name: "Custom Shiba" }).getAttribute("data-employee-role")).toBe("custom");
  });

  it("supports an accessible name or a decorative avatar without duplicating nearby copy", () => {
    const { rerender, container } = render(<RoleShiba slug="sales-bot" label="My account partner" />);
    expect(screen.getByRole("img", { name: "My account partner" })).toBeTruthy();
    rerender(<RoleShiba slug="sales-bot" decorative />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("provides distinct accessories without changing template configuration", () => {
    const before = JSON.stringify(EMPLOYEE_TEMPLATES);
    const shapes = EMPLOYEE_TEMPLATES.map((template) => {
      const { container, unmount } = render(<RoleShiba slug={template.slug} />);
      const accessory = container.querySelector("svg > g:last-child")?.innerHTML;
      unmount();
      return accessory;
    });
    expect(new Set(shapes).size).toBe(7);
    expect(shapes.every(Boolean)).toBe(true);
    expect(JSON.stringify(EMPLOYEE_TEMPLATES)).toBe(before);
  });
});
