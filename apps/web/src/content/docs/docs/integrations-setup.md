---
title: Set up integrations
description: Turn on app integrations by pointing Shiba at an OpenConnector worker.
---

App integrations (Stripe, HubSpot, Google Ads, Meta Ads, Notion, Gmail, Google Calendar, Slack, GitHub) run through an OpenConnector worker. Until one is configured, the Integrations page shows a **Set up integrations** card and lists these apps as "Needs setup". Nothing errors; the apps light up once the worker is reachable.

## Environment variables

Set these on the Shiba backend worker (names only; keep values in your secret store):

| Name | Kind | Purpose |
| --- | --- | --- |
| `OPEN_CONNECTOR` | service binding | Binding to the OpenConnector worker. Preferred when both run in one Cloudflare account. |
| `OPEN_CONNECTOR_URL` | variable | HTTPS URL of an OpenConnector deployment. Used when there is no binding. |
| `OPEN_CONNECTOR_ADMIN_TOKEN` | secret | Lets Shiba manage connections. |
| `OPEN_CONNECTOR_RUNTIME_TOKEN` | secret | Lets Shiba run approved actions. |
| `OPEN_CONNECTOR_ENABLED` | variable | Optional. `1` or `true` turns the integration on; a binding or URL also enables it. |

## Steps

1. Deploy the OpenConnector worker, or set `OPEN_CONNECTOR_URL` to an existing one.
2. Add the admin and runtime tokens as secrets.
3. Reload the Integrations page. The setup card disappears and each featured app shows its live status.
