// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { newRunOutputArchivePolicy } from "@shiba/shared";
import { RunOutputArchivePolicy } from "./RunOutputArchivePolicy";
afterEach(cleanup);
it("shows exact native owner lease and conservative recovery/resource boundary before approval", () => {
  const policy = newRunOutputArchivePolicy(Date.now(), "native-original");
  render(<RunOutputArchivePolicy policy={policy} />);
  expect(screen.getByLabelText("Frozen output archive policy").textContent).toContain(new Date(policy.expiresAt).toISOString());
  expect(screen.getByText(/Original native account/).textContent).toContain("native-original");
  expect(screen.getByText(/After container replacement/).textContent).toContain("unacknowledged tail is unknown");
  expect(screen.getByText(/Policy v1/).textContent).toContain("not a billing limit");
});
it("never invents a readable archive claim for an unverified policy", () => {
  render(<RunOutputArchivePolicy policy={{ version: 1, expiresAt: Date.now() + 1000 }} />);
  expect(screen.getByRole("alert").textContent).toContain("cannot be verified");
  expect(screen.queryByLabelText("Frozen output archive policy")).toBeNull();
});
