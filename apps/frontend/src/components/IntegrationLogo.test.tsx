// @vitest-environment happy-dom
import { integrationLogos } from "@shiba/shared";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { IntegrationLogo } from "./IntegrationLogo";

afterEach(cleanup);

describe("integration brand logos", () => {
  it("uses local brand assets before upstream images", () => {
    const { container } = render(<IntegrationLogo providerKey="slack" logoUrl="https://elsewhere.test/fake.png" />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/integration-logos/slack-icon.svg");
  });

  it("shows every brand in a grouped entry", () => {
    const { container } = render(<IntegrationLogo providerKey="google-drive-docs-sheets" />);
    expect(container.querySelectorAll("img")).toHaveLength(3);
    expect(integrationLogos(" Jira & Confluence ").map((logo) => logo.name)).toEqual(["Jira", "Confluence"]);
  });

  it.each(["javascript:alert(1)", "http://example.test/logo.png", "data:image/svg+xml,fake", "https://user:password@example.test/logo.png"])("rejects unsafe upstream URL %s", (logoUrl) => {
    const { container } = render(<IntegrationLogo providerKey="unknown-service" logoUrl={logoUrl} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("keeps unknown brand names neutral and falls back when an upstream image fails", () => {
    expect(integrationLogos("not-slack")).toEqual([]);
    expect(integrationLogos("constructor")).toEqual([]);
    expect(integrationLogos("__proto__")).toEqual([]);
    const { container } = render(<IntegrationLogo providerKey="unknown-service" logoUrl="https://example.test/logo.png" />);
    expect(container.querySelector("img")?.getAttribute("referrerpolicy")).toBe("no-referrer");
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("does not keep a failed logo when the provider changes", () => {
    const { container, rerender } = render(<IntegrationLogo providerKey="slack" />);
    fireEvent.error(container.querySelector("img")!);
    rerender(<IntegrationLogo providerKey="github" />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/integration-logos/github-icon.svg");
  });
});
