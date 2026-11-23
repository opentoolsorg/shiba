// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SHIBA_BRAND_LOOK, ShibaMark } from "./ShibaMark";

afterEach(cleanup);

describe("Shiba brand mark", () => {
  it("uses the real portrait with the brand mascot as a load-failure fallback", () => {
    render(<ShibaMark />);
    const logo = screen.getByRole("img", { name: "Shiba" });
    const portrait = logo.querySelector('img[src="/assets/mascot/pet-logo.png"]');
    expect(portrait).toBeTruthy();
    fireEvent.error(portrait!);
    const svg = logo.querySelector("svg.shiba-agent-mascot");
    expect(svg?.getAttribute("data-shape")).toBe("pointed");
    expect(svg?.getAttribute("data-color")).toBe("#c4a574");
    expect(svg?.getAttribute("data-eyes")).toBe("happy");
    expect(svg?.getAttribute("data-acc")).toBe("none");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 64 64");
    expect(SHIBA_BRAND_LOOK).toEqual({ shape: "pointed", color: "#c4a574", eyes: "happy", acc: "none" });
  });

  it("keeps the mark unsheeted so it sits on any surface", () => {
    render(<ShibaMark />);
    const logo = screen.getByRole("img", { name: "Shiba" });
    expect(logo.className).not.toContain("bg-[var(--card)]");
    expect(logo.className).not.toContain("border");
  });

  it("names itself, or hides from assistive tech inside a named control", () => {
    render(<div>
      <ShibaMark label="Shiba Guard" className="size-5" />
      <button type="button" aria-label="Shiba Home"><ShibaMark className="size-7" decorative /></button>
    </div>);
    expect(screen.getByRole("img", { name: "Shiba Guard" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Shiba Home" })).toBeTruthy();
    expect(screen.queryByRole("img", { name: "Shiba" })).toBeNull();
  });

  it("takes a size class and can be decorative", () => {
    const { rerender } = render(<ShibaMark className="size-6" />);
    expect(screen.getByRole("img", { name: "Shiba" }).className).toContain("size-6");
    rerender(<ShibaMark decorative />);
    expect(screen.queryByRole("img", { name: "Shiba" })).toBeNull();
  });
});
