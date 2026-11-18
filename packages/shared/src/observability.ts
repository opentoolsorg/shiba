import { z } from "zod";

export const dashboardObservationSchema = z.strictObject({
  event: z.enum([
    "dashboard.opened",
    "dashboard.render_error",
    "dashboard.unhandled_error",
    "dashboard.unhandled_rejection",
  ]),
});

export type DashboardObservation = z.infer<typeof dashboardObservationSchema>;
