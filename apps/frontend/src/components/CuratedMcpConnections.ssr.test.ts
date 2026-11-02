import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CuratedMcpConnections } from "./CuratedMcpConnections";

describe("curated MCP connection SSR", () => {
  it("renders available connection controls without a browser or making a request", () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    try {
      expect(typeof window).toBe("undefined");
      const html = renderToStaticMarkup(createElement(CuratedMcpConnections));
      for (const vendor of ["Stripe", "Notion", "Sentry"]) expect(html).toContain(vendor);
      expect(html.match(/Connect with OAuth/g)).toHaveLength(3);
      expect(html).toContain("Bearer fallback (optional)");
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
