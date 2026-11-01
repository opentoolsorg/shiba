// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ShibaMark } from "./ShibaMark";

afterEach(cleanup);

describe("Shiba brand mark", () => {
  it("uses the canonical logo with accessible text and neutral token backing", () => {
    const { rerender } = render(<ShibaMark />);
    const logo = screen.getByRole("img", { name: "Shiba" });
    expect(logo.getAttribute("src")).toBe("/assets/mascot/pet-logo.png");
    expect(logo.className).toContain("bg-[var(--card)]");
    expect(logo.className).toContain("object-contain");
    rerender(<ShibaMark className="size-6" />);
    expect(screen.getByRole("img", { name: "Shiba" }).className).toContain("size-6");
  });
});
