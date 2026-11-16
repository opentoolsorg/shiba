import type { JSX } from "react";
import type { SetupStatus } from "../live-status";

const CARD = "border border-[color-mix(in_oklch,var(--warning)_40%,transparent)] bg-[var(--warning-subtle)] px-4 py-3 text-left text-xs text-[var(--fg)]";
const LINK = "underline focus-visible:outline-2 focus-visible:outline-[var(--ring)]";

export const MODEL_ROUTE_CARD_TITLE = "Connect ChatGPT or Claude to run tasks";

/** Shown while the workspace has no usable model route; null once ready or unknown. */
export function ModelRouteCard({ modelRoute, onConnect }: { modelRoute: SetupStatus["modelRoute"]; onConnect?: () => void }): JSX.Element | null {
  if (!modelRoute || modelRoute.ready) return null;
  const href = modelRoute.fix?.href ?? "/settings/?section=providers";
  return (
    <div role="status" data-testid="model-route-card" className={CARD}>
      <p className="font-medium">{MODEL_ROUTE_CARD_TITLE}</p>
      <p className="mt-1 text-[var(--muted-foreground-1)]">Tasks can't start until a provider is linked. It takes a minute.</p>
      {onConnect
        ? <button type="button" onClick={onConnect} className={`mt-2 min-h-11 ${LINK}`}>Connect</button>
        : <a href={href} className={`mt-2 inline-flex min-h-11 items-center ${LINK}`}>Connect</a>}
    </div>
  );
}

const SLACK_STEPS = [
  "Create a Slack app from slack-app-manifest.yaml in the repository.",
  "Add SLACK_SIGNING_SECRET and SLACK_BOT_TOKEN as secrets (Cloudflare or your server's secret store).",
  "Install the app in your Slack workspace, then invite it to a channel.",
];

/** Three-step Slack setup; replaces error banners when Slack isn't installed yet. */
export function SlackSetupCard(): JSX.Element {
  return (
    <section aria-label="Set up Slack" data-testid="slack-setup-card" className={CARD}>
      <p className="font-medium">Set up Slack in three steps</p>
      <ol className="mt-1 list-decimal space-y-1 pl-4 text-[var(--muted-foreground-1)]">
        {SLACK_STEPS.map((step) => <li key={step}>{step}</li>)}
      </ol>
      <a href="/docs/slack-setup/" className={`mt-2 inline-flex min-h-11 items-center ${LINK}`}>Slack setup guide</a>
    </section>
  );
}

/** Web search, image and browser tools with a "Needs setup" chip naming the missing env. */
export function ToolSetupList({ tools }: { tools: SetupStatus["toolSetup"] }): JSX.Element | null {
  if (!tools?.length) return null;
  return (
    <section aria-label="Agent tool setup" className="space-y-2 text-xs">
      <h3 className="text-sm font-semibold">Search, image and browser tools</h3>
      <ul className="space-y-1">
        {tools.map((tool) => (
          <li key={tool.id} className="flex flex-wrap items-center gap-2">
            <span>{tool.label}</span>
            {tool.ready
              ? <span className="border border-[var(--border-1)] px-1.5 py-0.5 font-mono text-[10px]">Ready</span>
              : <span className="border border-[var(--warning)] bg-[var(--warning-subtle)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--warning-fg)]">Needs setup · {tool.env}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
