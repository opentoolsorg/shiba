/**
 * Workspace credits — prepaid USD bought through Stripe Checkout. Stripe
 * keys and customer ids stay in the Worker; this card only sees balances
 * and the Stripe-hosted URLs it is sent to.
 */
import { useState, type JSX } from "react";
import type { WorkspaceBilling, WorkspaceTopUp } from "@shiba/shared";
import { LoadErrorState } from "./LoadErrorState";
import { ToneChip, type ChipTone } from "./ToneChip";
import { viewButtonClass } from "./ui/ViewChrome";
import { openWorkspaceBillingPortal, startWorkspaceTopUp, useWorkspaceBilling } from "../live-status";

const PRESETS = [10, 25, 100] as const;
const TOP_UP_TONE: Record<WorkspaceTopUp["status"], ChipTone> = { succeeded: "ok", pending: "pending", failed: "danger", expired: "neutral" };
const TOP_UP_LABEL: Record<WorkspaceTopUp["status"], string> = { succeeded: "Paid", pending: "Waiting for Stripe", failed: "Failed", expired: "Expired" };

const usd = (n: number): string => `${n < 0 ? "−" : ""}$${Math.abs(n).toFixed(2)}`;
const day = (ms: number): string => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

function returnNotice(): string | null {
  if (typeof window === "undefined") return null;
  const status = new URLSearchParams(window.location.search).get("billing");
  if (status === "success") return "Payment received. Credits appear here as soon as Stripe confirms it.";
  if (status === "cancelled") return "Checkout was cancelled. Nothing was charged.";
  return null;
}

export function WorkspaceBillingCard({ sessionId, sessionApiAvailable }: { sessionId: string; sessionApiAvailable: boolean }): JSX.Element | null {
  const billing = useWorkspaceBilling(sessionId, sessionApiAvailable);
  if (billing.state.kind === "loading") return null;
  if (billing.state.kind === "error") {
    return (
      <BillingShell>
        <div className="px-4 py-3"><LoadErrorState message={billing.state.message} onRetry={billing.reload} /></div>
      </BillingShell>
    );
  }
  const data = billing.state.data.billing;
  if (data === undefined) return null;
  return <BillingShell mode={data.mode}>{data.enabled ? <BillingBody billing={data} sessionId={sessionId} sessionApiAvailable={sessionApiAvailable} /> : <BillingOff missing={data.missing} />}</BillingShell>;
}

function BillingShell({ mode, children }: { mode?: WorkspaceBilling["mode"]; children: JSX.Element }): JSX.Element {
  return (
    <section aria-labelledby="workspace-credits-title" className="rounded-xl border border-[#e4e4e7] bg-white overflow-hidden dark:border-zinc-800 dark:bg-zinc-900/40">
      <header className="flex items-center justify-between gap-3 border-b border-[#e4e4e7] px-4 py-3 dark:border-zinc-800">
        <div>
          <h3 id="workspace-credits-title" className="text-xs font-semibold text-[#0a0a0a] dark:text-zinc-100">Workspace credits</h3>
          <p className="text-[11px] text-[#71717a] dark:text-zinc-400">Prepaid balance that funds runs. Paid securely through Stripe.</p>
        </div>
        {mode === "test" ? <ToneChip tone="pending" label="Stripe test mode" /> : null}
      </header>
      {children}
    </section>
  );
}

function BillingOff({ missing }: { missing: string[] }): JSX.Element {
  return (
    <div className="px-4 py-4">
      <p className="text-xs text-[#0a0a0a] dark:text-zinc-200">Billing is off on this deployment, so runs are limited only by your spending limits.</p>
      <details className="mt-2 text-[11px] text-[#71717a] dark:text-zinc-400">
        <summary className="flex min-h-11 cursor-pointer items-center font-medium text-[var(--primary)]">Setup details for admins</summary>
        <p className="border-l-2 border-[#e4e4e7] py-1 pl-3 dark:border-zinc-700">
          Set these Worker secrets to turn on prepaid credits: <span className="font-mono text-[#0a0a0a] dark:text-zinc-200">{missing.join(", ")}</span>.
          Point a Stripe webhook for checkout.session events at <span className="font-mono">/api/billing/stripe/webhook</span>.
        </p>
      </details>
    </div>
  );
}

function BillingBody({ billing, sessionId, sessionApiAvailable }: { billing: WorkspaceBilling; sessionId: string; sessionApiAvailable: boolean }): JSX.Element {
  const [amount, setAmount] = useState<string>("25");
  const [busy, setBusy] = useState<"checkout" | "portal" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice] = useState(returnNotice);
  const parsed = Number(amount);
  const amountValid = Number.isInteger(parsed) && parsed >= billing.limits.minUsd && parsed <= billing.limits.maxUsd;

  const go = (action: "checkout" | "portal"): void => {
    setBusy(action);
    setError(null);
    const request = action === "checkout"
      ? startWorkspaceTopUp(parsed, sessionId, sessionApiAvailable)
      : openWorkspaceBillingPortal(sessionId, sessionApiAvailable);
    void request
      .then((url) => window.location.assign(url))
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
        setBusy(null);
      });
  };

  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      {notice !== null ? <p role="status" className="rounded-md bg-[#f4f4f5] px-3 py-2 text-[11px] text-[#0a0a0a] dark:bg-zinc-800 dark:text-zinc-200">{notice}</p> : null}
      {billing.exhausted ? (
        <p role="alert" className="rounded-md bg-rose-500/10 px-3 py-2 text-[11px] font-medium text-rose-700 dark:text-rose-300">
          Out of credits. New runs won&apos;t start, and running ones stop, until you add credits.
        </p>
      ) : null}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[11px] text-[#71717a] dark:text-zinc-400">Balance</div>
          <div className={`text-2xl font-semibold tabular-nums ${billing.exhausted ? "text-rose-600 dark:text-rose-400" : "text-[#0a0a0a] dark:text-zinc-100"}`}>{usd(billing.balanceUsd)}</div>
          <div className="text-[11px] tabular-nums text-[#71717a] dark:text-zinc-400">
            {usd(billing.creditedUsd)} added · {usd(billing.spentUsd)} used{billing.since !== null ? ` since ${day(billing.since)}` : ""}
          </div>
        </div>
        <button type="button" className={viewButtonClass} disabled={!billing.hasCustomer || busy !== null} onClick={() => go("portal")}
          title={billing.hasCustomer ? undefined : "Available after your first top-up"}>
          {busy === "portal" ? "Opening Stripe…" : "Manage billing"}
        </button>
      </div>

      <div className="flex flex-col gap-2 border-t border-[#e4e4e7] pt-3 dark:border-zinc-800">
        <span id="top-up-label" className="text-xs font-semibold text-[#0a0a0a] dark:text-zinc-100">Add credits</span>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-labelledby="top-up-label">
          {PRESETS.map((preset) => (
            <button key={preset} type="button" aria-pressed={amount === String(preset)} onClick={() => setAmount(String(preset))}
              className={`${viewButtonClass} min-w-16 tabular-nums ${amount === String(preset) ? "border-zinc-900 dark:border-zinc-100" : ""}`}>
              ${preset}
            </button>
          ))}
          <label className="flex min-h-11 items-center gap-1.5 rounded-lg border border-[#e4e4e7] px-3 text-[13px] text-[#71717a] focus-within:border-zinc-400 dark:border-zinc-700 dark:text-zinc-400">
            $
            <input aria-label="Custom amount in dollars" inputMode="numeric" value={amount} onChange={(event) => setAmount(event.target.value.replace(/[^0-9]/g, ""))}
              className="w-16 bg-transparent tabular-nums text-[#0a0a0a] focus:outline-none dark:text-zinc-100" />
          </label>
          <button type="button" className={`${viewButtonClass} bg-zinc-900 text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900`} disabled={!amountValid || busy !== null} onClick={() => go("checkout")}>
            {busy === "checkout" ? "Opening checkout…" : amountValid ? `Add $${parsed}` : "Add credits"}
          </button>
        </div>
        <p className="text-[11px] text-[#71717a] dark:text-zinc-400">
          Whole dollars from {usd(billing.limits.minUsd)} to {usd(billing.limits.maxUsd)}. Credits cover computer time and models this deployment pays for; your own provider keys and plan subscriptions aren&apos;t charged.
        </p>
        {error !== null ? <p className="text-[11px] text-rose-600 dark:text-rose-400">Couldn&apos;t open Stripe: {error}</p> : null}
      </div>

      {billing.topUps.length > 0 ? (
        <div className="border-t border-[#e4e4e7] pt-3 dark:border-zinc-800">
          <p className="text-xs font-medium text-[#71717a] dark:text-zinc-400">Recent top-ups</p>
          <ul className="mt-2 flex flex-col">
            {billing.topUps.map((topUp) => (
              <li key={topUp.id} className="flex items-center justify-between gap-3 border-b border-[#e4e4e7] py-2 last:border-b-0 dark:border-zinc-800">
                <span className="text-[11px] tabular-nums text-[#0a0a0a] dark:text-zinc-200">{usd(topUp.amountUsd)} · {day(topUp.createdAt)}</span>
                <ToneChip tone={TOP_UP_TONE[topUp.status]} label={TOP_UP_LABEL[topUp.status]} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
