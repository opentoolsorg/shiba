import { createFileRoute, useLocation } from "@tanstack/react-router";
import { Toaster } from "sonner";
import { App } from "../app";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { ThemeProvider, useTheme } from "../components/ThemeProvider";
import { SlackRunCanvas } from "../components/SlackRunCanvas";

export const Route = createFileRoute("/$")({
  component: DashboardRoute,
});

function DashboardRoute() {
  const location = useLocation();
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <DashboardContent pathname={location.pathname} search={location.searchStr} />
        <ThemedToaster />
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export function DashboardContent({ pathname, search }: { pathname: string; search: string }) {
  return pathname === "/slack-canvas" || pathname === "/slack-canvas/"
    ? <SlackRunCanvas search={search} />
    : <App />;
}

function ThemedToaster() {
  const { resolvedTheme } = useTheme();
  return (
    <Toaster
      theme={resolvedTheme === "dark" ? "dark" : "light"}
      // Keep transient notifications away from the task composer submit
      // control, which is anchored at the bottom-right of the viewport.
      position="top-right"
      richColors
    />
  );
}
