// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SettingsSectionBody } from "./settings-sections";
import { saveRepo } from "../saved";
vi.mock("../saved", () => ({useSavedRepos: () => [], saveRepo: vi.fn(), removeRepo: vi.fn()}));
const github = { token: true, app: false, publish: true, webhookSecret: false };
beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => Response.json({ github }))));
afterEach(() => {cleanup();vi.clearAllMocks();vi.unstubAllGlobals();});
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
  it("says a local draft grants nothing and links to task creation and environment checks", () => {
    const onNavigate = vi.fn();
    const onSelectSection = vi.fn();
    render(<SettingsSectionBody section="repositories" onNavigate={onNavigate} onSelectSection={onSelectSection} />);
    expect(screen.getByText(/does not connect GitHub, start a run, or grant access/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", {name:"Create a task →"}));
    expect(onNavigate).toHaveBeenCalledWith("work");
    fireEvent.click(screen.getByRole("button", {name:"View environment checks →"}));
    expect(onSelectSection).toHaveBeenCalledWith("environments");
  });
  it("shows read-only GitHub readiness rows from setup status", async () => {
    render(<SettingsSectionBody section="repositories" />);
    expect(await screen.findByText("Pull request publishing")).toBeTruthy();
    expect(screen.getByText("GitHub token")).toBeTruthy();
    expect(screen.getByText("GitHub App")).toBeTruthy();
    expect(screen.getByText("Webhook secret")).toBeTruthy();
    expect(screen.getAllByText("Configured")).toHaveLength(2);
    expect(screen.getAllByText("Not configured")).toHaveLength(2);
    expect(screen.queryByRole("button", {name:/connect github/i})).toBeNull();
  });
});
