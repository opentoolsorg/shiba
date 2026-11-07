---
title: Connections and tools
description: Give an AI employee the model and app access its job needs, without granting everything at once.
---

Connections let your AI employees work with the tools you already use. Start with the task you want done, then connect the accounts and grant only the access it needs.

## Three separate choices

- **Model connection:** the AI service used to do the work. Check it under **Providers** and in the selected task route.
- **App connection:** a signed-in account for a service such as a project tracker or messaging app. Manage available accounts under **Integrations**.
- **Employee permissions:** which tools and resources a particular employee may use. Review these under **Tool policy**.

Connecting an account does not grant it to every employee. A personal account is not automatically shared with a team workspace, and a workspace connection still needs explicit grants.

## Connect an app

1. Open **Integrations** and find the service you need.
2. Read its setup status. A catalog listing shows a possible integration, not an already connected account.
3. Complete the supported sign-in flow for the account you intend to use.
4. Review the employee's tool permissions and the resources it may access.
5. Try a small task and inspect the result and any action approval before relying on it.

Shiba uses **OpenConnector** for its app-account catalog. The person running your installation must configure that service and the relevant provider setup. A “ready” setup label means the sign-in route is configured; it does not prove that your account is connected or that every vendor action works.

Use **Reconnect** when an owned account is expired or unavailable and the supported setup is ready. An active account must be disconnected explicitly before replacement.

If setup is unavailable, ask your workspace operator. Do not paste API keys, passwords, or tokens into a task as a workaround. General API-key/custom-account execution in the OpenConnector operator path remains disabled; review-only enrollment is not permission to execute.

## Add tools through MCP

**MCP** is a standard for connecting AI tools. Shiba supports configured remote MCP servers and curated presets in a separate setup area.

A preset is a starting configuration. It does not connect an account or approve its tools. Your operator must verify the server and authentication setup, and review and enable the tools before use. See the [MCP reference](/docs/mcp/) for setup details.

## Work where your team already talks

A chat connection is a way to request work; it is separate from giving an employee access to an app account. Channel setup and the supported task flow vary:

- [Slack](/docs/slack/)
- [Linear](/docs/linear-agent-session/)
- [Telegram](/docs/telegram/)
- [Discord](/docs/discord/)

For codebase work, see [GitHub](/docs/github/). To use a paired machine, see [Your computers](/docs/remote-access/).

## Check before you rely on a connection

A logo, template, preset, or successful local test is not proof of a live integration. Confirm the account, permissions, action result, and any service-specific limits in your own installation.

Next: [Approve the right actions](/docs/approval-gates/) or [check product status](/docs/product-status/).
