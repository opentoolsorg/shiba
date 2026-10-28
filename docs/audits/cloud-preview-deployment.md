# Cloudflare preview deployment status

The user authorized preview testing and redeployment from the cloud environment
on 2026-10-28. No deployment was completed in this environment.

## Checks performed

- Pinned Wrangler **4.140.0** runs successfully.
- `wrangler whoami` reports **not authenticated**. No Cloudflare API token or
  account ID is configured, and no cached Wrangler login was found.
- HTTPS access to `api.cloudflare.com` fails at the environment proxy with
  **CONNECT 403**, before reaching the Cloudflare API.
- The current Worker and dashboard assets bundle successfully with
  `wrangler deploy --dry-run --containers-rollout none`. Output is retained in
  `.verify/cloud-deploy-bundle/`; log: `/tmp/shiba-cloud-deploy-dry-run.log`.
  This did not upload a Worker or build/update a container image.
- `pnpm check:deploy` passes binding/variable/secret-manifest drift checks.

Wrangler advertises temporary preview accounts for unauthenticated deployments.
Their API is also behind the blocked Cloudflare endpoint, so no temporary
account was created and no temporary deployment capability is claimed.

## Saved environment configuration

The environment draft preserves its existing domains and adds
`api.cloudflare.com`, `dash.cloudflare.com`, `registry.cloudflare.com`,
`app.tryshiba.dev`, and `*.workers.dev` for deployment, authentication, image
registry access, and preview testing. It declares an optional user-provided
`CLOUDFLARE_API_TOKEN` requirement restricted to `api.cloudflare.com` and a
nonsecret `CLOUDFLARE_ACCOUNT_ID` field. No credential values were supplied or
recorded.

The save is confirmed. It is a draft: review/save the environment settings and
publish the environment to activate the network and credential configuration.
An authenticated Wrangler login is also a supported alternative to an API token.

## Deployment continuation

After network access and authentication are available, verify `wrangler whoami`
and use an isolated stage such as `ALCHEMY_STAGE=bots-preview-20261028` with the
repository's Alchemy deployment entrypoint. Non-live stages suffix the Worker,
container and stores and omit the production custom domain. Use the actual
emitted preview URL; no URL has been generated or guessed here.

Test the preview's dashboard assets, authenticated API responses and Bot
creation/launch/approval/result behavior before redeploying. A reachable login
page or HTTP 401 alone does not establish a working Bot flow. Preserve mandatory
human approval, repository scope and existing secrets during any subsequent
deployment. Alchemy replaces its declared secret set, so an incomplete preview
secret file must not be reused to deploy over the live stack.

The previously recorded local/browser/Electron results remain valid local
evidence. They are not a deployed Cloudflare preview result. Deployment,
preview-URL testing and redeployment remain blocked on the prerequisites above.
