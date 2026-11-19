// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SHIBA_BRAND_LOOK, ShibaMark } from "./ShibaMark";

afterEach(cleanup);

describe("Shiba brand mark", () => {
  it("draws the public mark: sesame coat, resting face, no accessory", () => {
    render(<ShibaMark />);
    const logo = screen.getByRole("img", { name: "Shiba" });
    const svg = logo.querySelector("svg.shiba-agent-mascot");
    expect(svg?.getAttribute("data-shape")).toBe("pointed");
    expect(svg?.getAttribute("data-color")).toBe("#c4a574");
    expect(svg?.getAttribute("data-eyes")).toBe("happy");
    expect(svg?.getAttribute("data-acc")).toBe("none");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 64 64");
    expect(logo.querySelector("img")).toBeNull();
    expect(SHIBA_BRAND_LOOK).toEqual({ shape: "pointed", color: "#c4a574", eyes: "happy", acc: "none" });
  });

  it("keeps the mark unsheeted so it sits on any surface", () => {
    render(<ShibaMark />);
    const logo = screen.getByRole("img", { name: "Shiba" });
    expect(logo.className).not.toContain("bg-[var(--card)]");
    expect(logo.className).not.toContain("border");
  });

  it("takes a size class and can be decorative", () => {
    const { rerender } = render(<ShibaMark className="size-6" />);
    expect(screen.getByRole("img", { name: "Shiba" }).className).toContain("size-6");
    rerender(<ShibaMark decorative />);
    expect(screen.queryByRole("img", { name: "Shiba" })).toBeNull();
  });
});
