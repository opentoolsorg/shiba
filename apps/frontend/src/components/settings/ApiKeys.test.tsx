// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiKeysSettingsPanel } from "./ApiKeys";

describe("ApiKeysSettingsPanel", () => {
  it("renders API key settings", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ keys: [] })));
    render(<ApiKeysSettingsPanel />);
    expect(screen.getByTestId("api-keys-settings")).toBeTruthy();
    expect(screen.getByLabelText("API key label")).toBeTruthy();
    vi.unstubAllGlobals();
  });
});