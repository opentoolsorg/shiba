// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SettingsSectionBody } from "./settings-sections";
import { saveRepo } from "../saved";
vi.mock("../saved", () => ({useSavedRepos: () => [], saveRepo: vi.fn(), removeRepo: vi.fn()}));
afterEach(() => {cleanup();vi.clearAllMocks();});
describe("settings repositories", () => {
  it.each(["owner/repo", "github.com/owner/repo", "https://github.com/owner/repo.git"])("saves canonical URL for %s", (input) => {
    render(<SettingsSectionBody section="repositories" />);
    fireEvent.change(screen.getByRole("textbox", {name: "New repository URL"}), {target:{value:input}});
    fireEvent.click(screen.getByRole("button", {name:"Save repo"}));
    expect(saveRepo).toHaveBeenCalledWith("https://github.com/owner/repo");
  });
  it("shows accessible field error without saving malformed repository", () => {
    render(<SettingsSectionBody section="repositories" />);
    const input=screen.getByRole("textbox", {name:"New repository URL"});
    fireEvent.change(input,{target:{value:"https://github.com/owner/repo/issues"}});
    fireEvent.click(screen.getByRole("button", {name:"Save repo"}));
    expect(saveRepo).not.toHaveBeenCalled();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toContain("owner/repo");
  });
});
