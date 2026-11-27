// @vitest-environment happy-dom
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { AGENT_MASCOT_FURS, defaultLookFor } from "@shiba/shared";
import { AgentLookStyler } from "./AgentLookStyler";

afterEach(cleanup);

it("supports roving focus, wraparound and Home/End for Shell color", () => {
  function Harness() {
    const [look, setLook] = useState(defaultLookFor("shiba"));
    return <AgentLookStyler id="shiba" {...look} onCustomize={setLook} onAutomatic={() => {}} />;
  }
  render(<Harness />);
  const radios = within(screen.getByRole("radiogroup", { name: "Shell color" })).getAllByRole("radio");
  expect(radios.filter((radio) => radio.tabIndex === 0)).toHaveLength(1);
  const first = radios[0]!;
  fireEvent.keyDown(first, { key: "End" });
  expect(document.activeElement).toBe(radios.at(-1));
  expect(radios.at(-1)?.getAttribute("aria-checked")).toBe("true");
  fireEvent.keyDown(radios.at(-1)!, { key: "ArrowRight" });
  expect(document.activeElement).toBe(first);
  fireEvent.keyDown(first, { key: "ArrowLeft" });
  expect(document.activeElement).toBe(radios.at(-1));
  fireEvent.keyDown(radios.at(-1)!, { key: "Home" });
  expect(document.activeElement).toBe(first);
  expect(first.getAttribute("aria-label")).toBe(AGENT_MASCOT_FURS[0]?.label);
  expect(radios.filter((radio) => radio.tabIndex === 0)).toHaveLength(1);
});


it("previews the generated robot portrait for an automatic custom employee", () => {
  const { container } = render(<AgentLookStyler id="research-partner" shape="" color="" eyes="" acc="" onCustomize={() => {}} onAutomatic={() => {}} />);
  expect(container.querySelector("svg.shiba-agent-mascot")).toBeTruthy();
  expect(container.querySelector("svg[data-brand-mark='shiba-dog']")).toBeNull();
});
