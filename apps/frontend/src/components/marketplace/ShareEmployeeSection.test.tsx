// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ShareEmployeeSection } from "./ShareEmployeeSection";

afterEach(cleanup);

describe("ShareEmployeeSection", () => {
  it("says imports arrive archived with no grants and points at the templates directory", () => {
    render(<ShareEmployeeSection />);
    expect(screen.getByRole("heading", { name: "Share an employee" })).toBeTruthy();
    expect(screen.getByText(/Importing a bundle creates an archived bot with no grants/).textContent).toContain("no tool access is given");
    expect(screen.getByText(/templates\/ directory/)).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});
