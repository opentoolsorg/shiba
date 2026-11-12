// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ShibaMark } from "./ShibaMark";

afterEach(cleanup);

describe("Shiba brand mark", () => {
  it("uses the SVG Shiba with accessible text and neutral token backing", () => {
    const { rerender } = render(<ShibaMark />);
    const logo = screen.getByRole("img", { name: "Shiba" });
    expect(logo.querySelector("svg.shiba-agent-mascot")?.getAttribute("data-shape")).toBe("pointed");
    expect(logo.querySelector("img")).toBeNull();
    expect(logo.className).toContain("bg-[var(--card)]");
    rerender(<ShibaMark className="size-6" />);
    expect(screen.getByRole("img", { name: "Shiba" }).className).toContain("size-6");
    rerender(<ShibaMark decorative />);
    expect(screen.queryByRole("img", { name: "Shiba" })).toBeNull();
  });
});
