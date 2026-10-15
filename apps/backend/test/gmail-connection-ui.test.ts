// SSR smoke tests for the Gmail connection panel (same pattern as dashboard-components.test.ts).
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GmailConnection } from "../../frontend/src/components/GmailConnection";
import { IntegrationsView } from "../../frontend/src/components/IntegrationsView";

describe("Gmail connection panel SSR", () => {
  it("states the read-only, explicit-grant, bounded contract before any status loads", () => {
    const html = renderToStaticMarkup(React.createElement(GmailConnection));
    expect(html).toContain('aria-label="Gmail connection"');
    expect(html).toContain("Checking…");
    expect(html).toContain("read-only (gmail.readonly; Shiba cannot send, delete, or modify mail)");
    expect(html).toContain("only agents you explicitly authorize can search/read");
    expect(html).toContain("≤25 messages per call, text bodies capped at 20 KiB, no attachments");
    expect(html).toContain("mail content treated as untrusted");
    // The agent-token form only appears once a mailbox is connected.
    expect(html).not.toContain("gmail-agent-token");
    expect(html).not.toContain("Connect Gmail");
  });

  it("is mounted in the Integrations Email group", () => {
    const html = renderToStaticMarkup(React.createElement(IntegrationsView, {}));
    expect(html).toContain("read-only Gmail");
    expect(html).toContain('aria-label="Gmail connection"');
  });
});
