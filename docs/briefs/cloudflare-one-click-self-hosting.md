# Brief: one-click Cloudflare self-hosting

## Goal

Add a **Deploy to Cloudflare** entry point to the repository README so a new
operator can create their own copy of Shiba, provide configuration in a guided
flow, and deploy it into their own Cloudflare account without preparing a Mac,
checking out the code locally, or editing a `.env` file.

Deliver the product change as one pull request to `opentoolsorg/shiba`.

## Operator experience

1. The README button opens the supported Cloudflare deployment flow for this
   repository.
2. The operator is guided through creating a personal repository copy and
   connecting their Cloudflare account.
3. The flow provisions the resources Shiba actually needs and collects required
   values as protected secrets. It clearly marks optional integrations and
   explains where provider model keys belong.
4. The flow reports a deployed Worker URL and gives the operator the next step
   for signing in and configuring model access.

## Required configuration

- Cloudflare Workers Paid plan and the products required by Shiba's current
  deployment (Workers, Containers, Durable Objects, D1, KV, R2, Vectorize, and
  Workers AI).
- An AI Gateway configured with the operator's provider key, unless they choose
  a supported subscription lane.
- A GitHub credential scoped to the repository or repositories the operator
  approves for Shiba. Never pass a real GitHub token into a container.
- Access or the built-in Better Auth lane configured before exposing a public
  hostname. Preserve the approval-before-sandbox-start contract.
- Optional integration credentials only when the operator opts in.

The guided flow must not ask for provider keys that belong in AI Gateway BYOK.
It must not commit, log, expose in URLs, or bake secrets into the generated
repository.

## Product and deployment constraints

- Shiba is a pnpm monorepo whose Worker deploy provisions Cloudflare resources
  through `alchemy.run.ts`; deployment also builds the Sandbox image.
- The existing operator path needs Node.js, pnpm, and Docker. The hosted flow
  must replace those local prerequisites, not merely link to the current shell
  instructions.
- Alchemy replaces Worker secrets on deploy. The implementation must keep one
  source of truth for each new installation and must not mix Alchemy-managed
  secrets with ad hoc Wrangler secrets.
- Provision account-owned resources with unique, installation-specific names.
  Do not reuse the checked-in dogfood IDs or mutate the project's dogfood
  resources.
- State the Cloudflare plan and service costs plainly; do not imply that hosting
  or model usage is free.
- Keep the current manual self-hosting guide available for operators who prefer
  the CLI.

## Acceptance criteria

- README has one clearly labeled Cloudflare deploy button and a short note about
  prerequisites/costs.
- A fresh test account can follow the flow from repository copy through a
  reachable Worker without a local Mac, `.env` setup, or local Docker build.
- Required values are validated before deploy; optional integrations remain
  disabled unless configured.
- A failed or cancelled flow leaves no public unauthenticated Worker and gives
  the operator a clear cleanup path for resources already created.
- The deployed Worker has isolated resources and secrets; it does not point at
  dogfood resources or expose credentials to a container.
- Verify README links, the deployment flow, secret handling, and the approval
  gate in automated or documented acceptance checks.
- Submit one PR to `opentoolsorg/shiba` with the implementation, docs, and
  verification evidence.

## Open implementation question

Confirm whether Cloudflare's current repository deploy flow can satisfy the
monorepo, Alchemy provisioning, protected secret collection, and remote Sandbox
image build requirements. If not, build a small guided bootstrap flow that
creates a repository copy and runs the supported deployment pipeline. Do not
ship a stock deploy button that only builds the Worker bundle while implying
that the full Shiba stack is provisioned.
