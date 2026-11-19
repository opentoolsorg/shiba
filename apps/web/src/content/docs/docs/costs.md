---
title: Costs
description: Understand what you pay for when you use or host Shiba.
---

Shiba is free, open-source software. Running a workspace can still incur charges for hosting and the AI services it uses.

## If you use a team's workspace

The person who runs your installation chooses its hosting and model connections. Ask them which services are available and how usage is paid for.

There isn't a fixed price for every task. The model, task size, and time spent working can affect usage. Planning and automation-condition checks may incur usage before a workspace run is approved. A run-approval gate is not a guarantee of zero earlier model usage. Start with a small task when you're trying a new setup.

## If you run your own workspace

You pay your hosting and model providers for the services you configure. Review their current prices and set budgets or alerts where available. Shiba’s optional execution budget uses harness-reported costs and may have unreported runs; it is not a complete provider invoice or a hard cap on all account charges.

## Prepaid workspace credits

An installation can charge each workspace up front through Stripe. Set the Worker secrets `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`, then point a Stripe webhook for `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed` and `checkout.session.expired` at `https://<host>/api/billing/stripe/webhook`. `STRIPE_PORTAL_CONFIGURATION_ID` optionally picks a Billing Portal configuration. Use `sk_test_` keys to try it in Stripe test mode.

With both secrets set, **Analytics → Workspace credits** shows the balance and lets people add $5 to $500 at a time through Stripe Checkout or open the Billing Portal. Credits pay for computer time and for models the installation pays for. Runs on a person's own provider key, ChatGPT or Claude plan, or paired computer don't use model credits. When the balance reaches zero, approved runs don't start and running ones stop until someone adds credits. The spending limits still apply on top. Stripe keys and customer ids stay in the Worker and never reach the dashboard or a sandbox.

## Emergency stop for hosted models

Set `SHIBA_HOSTED_PROVIDER_KILL_SWITCH=1` to stop AI Gateway provider traffic, gateway-backed runs (refused before an approval is created), team model turns and the router classifier. People's own provider keys, plan subscriptions and paired computers keep working, so the switch stops the deployment's own spend rather than all inference. **Settings → Providers** tells people while the stop is on.

It does not stop Workers AI, which runs inside the Worker rather than through the gateway: chat replies and read-only specialist turns, note chat, session summaries, learning review, image generation, voice transcription and search embeddings keep working. Stop the deployment entirely if those must halt.

Credits are debited to a ledger when a run finishes, so clearing a task's history never refunds what it cost. Stripe refunds for a top-up remove the credits they reverse. A balance can go negative after a refund if the credits were already spent, and runs stay stopped until it is positive again. Setting `SHIBA_CREDITS_GATE_USER_FUNDED_RUNS=0` lets runs paid for by a plan subscription or a paired computer keep going at zero credits.

The [self-hosting guide](/docs/self-hosting/) covers setup. [Runtime costs and limits](/docs/runtime-limits/) lists the technical references for installation owners.
