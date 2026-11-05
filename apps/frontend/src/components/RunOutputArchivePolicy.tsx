import type { JSX } from "react";
import { runOutputArchivePolicySchema } from "@shiba/shared";

/** Display only the server-frozen policy that the human is actually deciding. */
export function RunOutputArchivePolicy({ policy }: { policy: unknown }): JSX.Element {
  const parsed = runOutputArchivePolicySchema.safeParse(policy);
  if (!parsed.success) return <p role="alert">The output archive policy cannot be verified. Reject this request and queue a fresh run.</p>;
  const value = parsed.data;
  return <section aria-label="Frozen output archive policy" className="min-w-0 border border-[var(--border-1)] bg-[var(--card)] p-3 text-xs leading-relaxed">
    <p>Retain a sanitized terminal archive for your original native account only, until {new Date(value.expiresAt).toISOString()}.</p>
    <p className="mt-2">Policy v{value.version}: reserve 8 MiB and at most 8,192 events for this job. Source limits remain 4 MiB and 4,096 frames. Room reservation: 16 MiB / 2 archives. Account reservation: 32 MiB / 4 archives. These are storage bounds, not a billing limit.</p>
    <p className="mt-2">After container replacement, only externally acknowledged sanitized output can be recovered. An unacknowledged tail is unknown. This approval never authorizes restarting the command or restoring its process.</p>
    <p className="mt-2 break-all font-mono">Original native account: {value.ownerAccountId}</p>
  </section>;
}
