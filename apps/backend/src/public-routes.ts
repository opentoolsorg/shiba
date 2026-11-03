/** Public, read-only site content. The dashboard and every other route stay private. */
export function isPublicStaticPath(path: string): boolean {
  return path === "/" || path === "/index.html"
    || path === "/waitlist" || path === "/waitlist/" || path === "/waitlist/index.html"
    || path === "/why-shiba" || path === "/why-shiba/" || path === "/why-shiba/index.html"
    || path === "/docs" || path === "/docs/" || path.startsWith("/docs/")
    || path.startsWith("/_astro/") || path.startsWith("/assets/") || path.startsWith("/pagefind/")
    || path === "/favicon.ico" || path === "/favicon.svg" || path === "/favicon-32x32.png"
    || path === "/robots.txt" || path === "/sitemap.xml" || path === "/sitemap-index.xml"
    || path === "/sitemap-0.xml" || path === "/llms.txt" || path === "/404.html";
}

export function isPublicRequest(request: Request): boolean {
  const path = new URL(request.url).pathname;
  return ((request.method === "GET" || request.method === "HEAD") && isPublicStaticPath(path))
    || (request.method === "GET" && path === "/api/v1/openapi.json")
    || (request.method === "GET" && path === "/api/integrations/provider/callback")
    || (request.method === "POST" && path === "/api/waitlist")
    // POST-only bypass so a Sentry alert reaches the handler even when the
    // edge Access gate is misconfigured; the handler still verifies the
    // shared secret before queueing anything.
    || (request.method === "POST" && path === "/api/sentry/webhook");
}

/** These route modules verify an org-scoped API key or dashboard session themselves. */
export function isOrgApiPath(path: string): boolean {
  return path === "/api/api-keys"
    || path === "/api/v1/extensions/skills" || path.startsWith("/api/v1/extensions/skills/")
    || path === "/api/skills/library" || path.startsWith("/api/skills/library/")
    || path === "/api/spaces" || path.startsWith("/api/spaces/")
    || path === "/api/employee-tools" || path.startsWith("/api/employee-tools/")
    || path === "/api/reason-network" || path.startsWith("/api/reason-network/")
    || path === "/api/custom-agents" || path.startsWith("/api/custom-agents/")
    || path === "/api/org/sandbox" || path === "/api/org/sandbox/test"
    || path === "/api/org/model-keys" || path.startsWith("/api/org/model-keys/");
}
