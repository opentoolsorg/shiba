/// <reference types="vite/client" />
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
} from "@tanstack/react-router";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "theme-color", content: "#fafafa" },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content",
      },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-title", content: "Shiba" },
      { name: "apple-mobile-web-app-status-bar-style", content: "black-translucent" },
      { name: "description", content: "Hire AI employees you own. Approve every move. Shiba runs on your own servers, on Cloudflare or any server you choose." },
      { property: "og:title", content: "Shiba Dashboard" },
      {
        property: "og:description",
        content: "Hire AI employees you own. Approve every move. Shiba runs on your own servers, on Cloudflare or any server you choose.",
      },
      { property: "og:type", content: "website" },
      // The ASSETS binding answers /app/* ahead of the Worker's own gate, but a
      // host fronted by Cloudflare Access (ACCESS_EMAILS set) gates it at the
      // edge too, so only an unproxied deployment serves this to a previewer.
      { property: "og:image", content: "/app/icon-512.png" },
      { property: "og:image:width", content: "512" },
      { property: "og:image:height", content: "512" },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:image", content: "/app/icon-512.png" },
      { title: "Shiba · Hire AI employees you own" },
    ],
    links: [
      { rel: "icon", type: "image/svg+xml", href: "/app/favicon.svg" },
      { rel: "icon", type: "image/png", sizes: "32x32", href: "/app/favicon-32x32.png" },
      { rel: "apple-touch-icon", sizes: "180x180", href: "/app/apple-touch-icon.png" },
      // use-credentials keeps the Access cookie on the manifest fetch.
      {
        rel: "manifest",
        href: "/app/manifest.webmanifest",
        crossOrigin: "use-credentials",
      },
      { rel: "stylesheet", href: appCss },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    // The blocking bootstrap reads the shared theme before the first paint.
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        <script src="/assets/theme-bootstrap.js" />
      </head>
      <body className="bg-[var(--bg)] text-[var(--fg)] antialiased selection:bg-[var(--primary)] selection:text-[var(--primary-text)] font-sans">
        <Outlet />
        <Scripts />
      </body>
    </html>
  );
}
