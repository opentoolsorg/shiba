// Component and hook tests for onboarding connections and modal/wizard flows.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { OnboardingModal } from "../../frontend/src/components/OnboardingModal";
import { FirstRunWizard } from "../../frontend/src/components/FirstRunWizard";
import { useOrgConnections } from "../../frontend/src/components/org-connections";

describe("OnboardingModal component tests", () => {
  it("renders step checklist with Test buttons and disabled Save buttons when sandbox expanded", () => {
    const html = renderToStaticMarkup(
      React.createElement(OnboardingModal, {
        isOpen: true,
        onClose: () => {},
        initialExpandedStep: "connect-sandbox",
      })
    );

    expect(html).toContain("Connect GitHub");
    expect(html).toContain("Connect Sandbox Runner");
    expect(html).toContain("Connect Model Keys");
    expect(html).toContain("Test Runner");
    expect(html).toContain("Save Runner");
    expect(html).toContain("cursor-not-allowed");
  });

  it("renders model test and save buttons when model step expanded", () => {
    const html = renderToStaticMarkup(
      React.createElement(OnboardingModal, {
        isOpen: true,
        onClose: () => {},
        initialExpandedStep: "connect-model",
      })
    );

    expect(html).toContain("Test Key");
    expect(html).toContain("Save Key");
    expect(html).toContain("cursor-not-allowed");
  });

  it("never renders secrets in the static HTML", () => {
    const html = renderToStaticMarkup(
      React.createElement(OnboardingModal, {
        isOpen: true,
        onClose: () => {},
        initialExpandedStep: "connect-sandbox",
      })
    );

    expect(html).not.toContain("sk-ant-");
    expect(html).not.toContain("ghp_yourTokenHere_real");
    expect(html).toContain('type="password"');
  });

  it("renders closed state without output", () => {
    const html = renderToStaticMarkup(
      React.createElement(OnboardingModal, { isOpen: false, onClose: () => {} })
    );
    expect(html).toBe("");
  });
});

describe("FirstRunWizard component tests", () => {
  it("renders the channel first-run step and links to the setup checklist", () => {
    const html = renderToStaticMarkup(
      React.createElement(FirstRunWizard, { open: true, onClose: () => {}, onOpenChecklist: () => {} })
    );

    expect(html).toContain("Welcome — 1 of 4");
    expect(html).toContain("Your channels");
    expect(html).toContain("GitHub");
    expect(html).toContain("Open the deployment checklist");
    expect(html).toContain("Skip setup");
    expect(html).toContain("Next");
  });
});

describe("useOrgConnections flow and security tests", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("requires candidate values and a successful test before allowing save", () => {
    let hookState: ReturnType<typeof useOrgConnections> = null as any;
    function Helper() {
      hookState = useOrgConnections();
      return null;
    }
    renderToStaticMarkup(React.createElement(Helper));

    expect(hookState.canSaveSandbox).toBe(false);
    expect(hookState.canSaveModel).toBe(false);
  });

  it("testSandbox calls POST /api/org/sandbox/test without persisting", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, message: "Runner reached" }),
    });
    globalThis.fetch = fetchMock;

    let hookState: ReturnType<typeof useOrgConnections> = null as any;
    function RunnerTestComponent() {
      hookState = useOrgConnections();
      return null;
    }
    renderToStaticMarkup(React.createElement(RunnerTestComponent));

    hookState.setRunnerUrl("https://runner.test.com");
    hookState.setRunnerToken("test-secret-token");

    const result = await hookState.testSandbox();
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/org/sandbox/test",
      expect.objectContaining({
        method: "POST",
      })
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/org/sandbox",
      expect.objectContaining({ method: "PATCH" })
    );
  });

  it("surfaces error text when saveSandbox fails and checks res.ok", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ ok: false, error: "runnerToken is required when setting or changing runnerUrl." }),
    });
    globalThis.fetch = fetchMock;

    let hookState: ReturnType<typeof useOrgConnections> = null as any;
    function RunnerSaveFail() {
      hookState = useOrgConnections();
      return null;
    }
    renderToStaticMarkup(React.createElement(RunnerSaveFail));

    hookState.setRunnerUrl("https://runner.test.com");
    const result = await hookState.saveSandbox();
    expect(result.ok).toBe(false);
    expect(result.error).toBe("runnerToken is required when setting or changing runnerUrl.");
  });

  it("saveSandbox clears secret token on success and keeps only last4", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        settings: {
          runnerUrl: "https://runner.test.com",
          runnerTokenMeta: { configured: true, last4: "8899" },
        },
      }),
    });
    globalThis.fetch = fetchMock;

    let hookState: ReturnType<typeof useOrgConnections> = null as any;
    function RunnerSaveSuccess() {
      hookState = useOrgConnections();
      return null;
    }
    renderToStaticMarkup(React.createElement(RunnerSaveSuccess));

    hookState.setRunnerUrl("https://runner.test.com");
    hookState.setRunnerToken("my-super-secret-1234");
    const result = await hookState.saveSandbox();
    expect(result.ok).toBe(true);
    expect(result.settings?.runnerTokenMeta?.last4).toBe("8899");
    expect(result.settings?.runnerTokenMeta?.configured).toBe(true);
  });

  it("saveModel clears secret apiKey on success and keeps only last4", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        key: { configured: true, last4: "4321" },
      }),
    });
    globalThis.fetch = fetchMock;

    let hookState: ReturnType<typeof useOrgConnections> = null as any;
    function ModelSaveSuccess() {
      hookState = useOrgConnections();
      return null;
    }
    renderToStaticMarkup(React.createElement(ModelSaveSuccess));

    hookState.setModelProvider("anthropic");
    hookState.setModelApiKey("sk-ant-test-secret-9999");
    const result = await hookState.saveModel();
    expect(result.ok).toBe(true);
    expect(result.key?.last4).toBe("4321");
    expect(result.key?.configured).toBe(true);
  });
});
