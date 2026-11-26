// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { CURATED_MCP_VENDORS } from "@shiba/shared";
import { McpServerList } from "./McpServerList";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("McpServerList", () => {
  it("lists every curated vendor with its connection methods and docs link, without any network call", () => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    render(<McpServerList />);
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(CURATED_MCP_VENDORS.length);
    CURATED_MCP_VENDORS.forEach((vendor, index) => {
      const item = rows[index];
      if (!item) throw new Error(`Expected a row for ${vendor.name}.`);
      const row = within(item);
      expect(row.getByRole("heading", { name: vendor.name })).toBeTruthy();
      const methods = vendor.connectionMethods.map((method) => method === "oauth" ? "OAuth sign-in" : "Bearer token").join(", ");
      expect(row.getByText(`Connection methods: ${methods}`)).toBeTruthy();
      const docs = row.getByRole("link", { name: `Docs for ${vendor.name} (opens in a new tab)` });
      expect(docs.getAttribute("href")).toBe(vendor.docsUrl);
      expect(docs.getAttribute("rel")).toBe("noopener noreferrer");
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("states that connecting a server grants no employee access and renders no connect or rating controls", () => {
    render(<McpServerList />);
    const note = screen.getByText(/Connecting a server does not give any employee access/);
    expect(note.textContent).toBe("Connecting a server does not give any employee access. Grant access separately in Tool policy.");
    expect(within(note).getByRole("link", { name: "Tool policy" }).getAttribute("href")).toBe("/employee-tools/");
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(/verified|rating|install/i);
  });

  it("does not link to the personal-only tool policy page inside a team workspace", () => {
    render(<McpServerList personalScope={false} />);
    expect(screen.queryByRole("link", { name: "Tool policy" })).toBeNull();
    expect(screen.getByText(/available in your personal workspace/)).toBeTruthy();
  });
});
