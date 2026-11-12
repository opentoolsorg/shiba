// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { mascotLookForPreset, resolveAgentMascotLook } from "@shiba/shared";
import { AgentMascot } from "./AgentMascot";

afterEach(cleanup);

describe("AgentMascot", () => {
  it("renders a bot whose name matches an inherited object property", () => {
    const { container } = render(<AgentMascot look={resolveAgentMascotLook({ id: "constructor", role: "custom" })} />);
    expect(container.querySelector("svg")?.getAttribute("data-color")).toMatch(/^#[0-9a-f]{6}$/);
  });
  it("marks the pointed ears, visor, eyes, and accessory", () => {
    const { container } = render(<AgentMascot look={mascotLookForPreset("sunglasses")} expression="squint" live label="Reviewer" />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("data-shape")).toBe("hex");
    expect(svg?.getAttribute("data-color")).toBe("#2a3138");
    expect(svg?.getAttribute("data-eyes")).toBe("squint");
    expect(svg?.getAttribute("data-expression")).toBe("squint");
    expect(svg?.getAttribute("data-acc")).toBe("loupe");
    expect(svg?.getAttribute("data-live")).toBe("true");
    expect(container.querySelector('[data-part="ears"]')?.querySelectorAll("path").length).toBe(2);
    expect(container.querySelector('[data-part="visor"]')).toBeTruthy();
    expect(container.querySelector('[data-part="eyes"]')).toBeTruthy();
    expect(container.querySelector('[data-part="accessory"]')).toBeTruthy();
    expect(container.querySelector('[data-part="fluff"]')).toBeTruthy();
  });

  it("omits the accessory mark when the look has none", () => {
    const { container } = render(<AgentMascot look={mascotLookForPreset("hero")} />);
    expect(container.querySelector('[data-part="accessory"]')).toBeNull();
    expect(container.querySelector("svg")?.getAttribute("data-acc")).toBe("none");
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });
});
