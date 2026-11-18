import type { DashboardObservation } from "@shiba/shared";
import { z } from "zod";

const statusSchema = z.strictObject({ errors: z.boolean(), analytics: z.boolean(), metrics: z.boolean() });
let reportRenderError: (() => void) | undefined;

export function reportDashboardRenderError(): void {
  reportRenderError?.();
}

export function startDashboardObservability(): () => void {
  const controller = new AbortController();
  let remaining = 10;
  const send = (event: DashboardObservation["event"]) => {
    if (controller.signal.aborted || remaining-- <= 0) return;
    void fetch("/api/observability", {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event } satisfies DashboardObservation), signal: controller.signal,
    }).catch(() => undefined);
  };
  const onError = () => send("dashboard.unhandled_error");
  const onRejection = () => send("dashboard.unhandled_rejection");
  const onRenderError = () => send("dashboard.render_error");
  void (async () => {
    try {
      const response = await fetch("/api/observability", { credentials: "same-origin", signal: controller.signal });
      if (!response.ok || controller.signal.aborted) return;
      const parsed = statusSchema.safeParse(await response.json());
      if (!parsed.success || controller.signal.aborted) return;
      const status = parsed.data;
      if ((status.analytics || status.metrics) && navigator.doNotTrack !== "1") send("dashboard.opened");
      if (status.errors || status.metrics) {
        window.addEventListener("error", onError);
        window.addEventListener("unhandledrejection", onRejection);
        reportRenderError = onRenderError;
      }
    } catch { /* Optional telemetry must never interrupt the dashboard. */ }
  })();
  return () => {
    controller.abort();
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
    if (reportRenderError === onRenderError) reportRenderError = undefined;
  };
}
