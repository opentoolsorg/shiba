---
title: Browser live view
description: Watch your agent browse, take over the tab, and approve a saved login.
---

Use Browser in dashboard Chat to watch Shiba work in a separate cloud browser. It doesn't share tabs, cookies, or passwords from the browser you use to open Shiba.

## Watch or take over

1. In a dashboard thread, switch the composer to **Chat** and enable **Browser** in the tools picker for your message. Ask Shiba to open a public website.
2. Open **Browser** in the thread. The panel refreshes while the tab is open and shows its address without query parameters or fragments.
3. Choose **Take over** to click, scroll, or type in the tab. Shiba's browser tools pause while you're in control. Choose **Hand back** to release control or **Stop** to close the browser and clear its website session.

Only the authenticated thread owner can view or control this browser. Take-over and hand-back are recorded in Audit. The browser closes at the end of the Chat turn or after three minutes without agent or human input; watching the tab doesn't reset that timer. An outstanding tool approval keeps the browser available until the approval or the idle timer ends.

## Use a saved login

1. Open **Integrations → Saved logins** in your personal workspace. For a workspace you own or administer, switch to that workspace and open **Integrations → Browser logins**.
2. Add a label, the website's exact HTTPS origin (for example, `https://accounts.example.com`), a username, and a password. You can add a base32 TOTP setup secret if the form asks for a code on the same page.
3. Copy the login ID, then ask Shiba in a Browser-enabled Chat turn to open the site and use that ID. Review the live address and approve the specific sign-in request. A personal login is available only in your own private Chat. A workspace owner or admin can use a workspace login in their own private Chat. Shared rooms and unattended work can't use saved logins.

Shiba checks that the page and form submit destination match the saved HTTPS origin before entering anything. A sibling host, different port, or redirect to another origin isn't a match. The browser is restricted to the originally opened hostname, so sites that require cross-host redirects or assets might not work. Saved sign-in supports a standard same-origin POST form in the main tab. For a multi-step login, an embedded form, a CAPTCHA, or a login that needs JavaScript submission, use **Take over** instead.

On every use, a person must approve the request in Chat. A later change to the saved login invalidates that approval. MCP clients can't grant the human approval themselves.

## Where credentials go

Shiba encrypts passwords and TOTP secrets in its Worker vault and never returns them from the saved-logins API. After approval, the Worker decrypts the password and, if needed, computes a one-time code. Only the website's sign-in form receives those values. The tool result reports the login label, origin, and whether the sign-in appeared to succeed; it does not include the password or TOTP secret.

The browser runs in Cloudflare Browser Rendering, outside the coding sandbox. The model can't access the browser's cookies or DevTools connection, and Shiba disables agent screenshots after saved sign-in. The private Browser panel still shows the tab to its owner. Browser tools don't start a coding sandbox or alter repository permissions.
