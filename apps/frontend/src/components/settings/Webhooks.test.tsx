// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WebhooksSettingsPanel } from "./Webhooks";

describe("WebhooksSettingsPanel", () => {
  it("renders the webhooks settings shell", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ subscriptions: [] })));
    render(<WebhooksSettingsPanel />);
    expect(screen.getByTestId("webhooks-settings")).toBeTruthy();
    expect(screen.getByLabelText("Webhook URL")).toBeTruthy();
    vi.unstubAllGlobals();
  });
});