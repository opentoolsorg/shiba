import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

// TanStack Start's required router entry (src/router.tsx → getRouter).
export function getRouter() {
  // No basepath: one splat route serves every view path; the shell file still lives at /app/index.html.
  return createRouter({
    routeTree,
    // The shell SSRs only the root, so every path must first paint this exact markup or React logs #418.
    defaultPendingComponent: () => (
      <div className="h-dvh bg-[var(--bg)] text-[var(--fg)] font-sans flex items-center justify-center">
        <p role="status" className="font-mono text-xs uppercase tracking-[0.14em] text-[var(--muted-foreground-2)]">
          Checking your session…
        </p>
      </div>
    ),
    trailingSlash: "always",
  });
}
