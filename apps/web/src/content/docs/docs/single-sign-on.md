---
title: Single sign-on
description: Configure company OIDC sign-in with Better Auth and keep workspace membership under invitation control.
---

Shiba can use one company OpenID Connect (OIDC) provider for dashboard sign-in. The provider is deployment-wide. [Better Auth’s generic OAuth plugin](https://better-auth.com/docs/plugins/generic-oauth) handles discovery, authorization code exchange, and PKCE with the `openid email profile` scopes.

## Configure the deployment

Configure these environment settings on the backend Worker. Store the client secret through your deployment's secret mechanism; do not commit its value.

| Setting | Purpose |
| --- | --- |
| `BETTER_AUTH_SECRET` | Enables the built-in auth lane; at least 32 characters. |
| `BETTER_AUTH_URL` | Canonical public dashboard URL, such as `https://shiba.example.com`. |
| `SHIBA_SSO_ENABLED` | Set to `1` to enable OIDC sign-in. |
| `SSO_OIDC_ISSUER` | HTTPS issuer URL, without the discovery document suffix. |
| `SSO_OIDC_CLIENT_ID` | Client ID issued for the Shiba application. |
| `SSO_OIDC_CLIENT_SECRET` | Client secret issued for the Shiba application. |
| `SSO_OIDC_DISPLAY_NAME` | Optional button name; defaults to `Company SSO`. |
| `SSO_ALLOWED_DOMAINS` | Comma-separated exact email domains, such as `example.com,subsidiary.example.com`. |

Register the following redirect URI with the identity provider, replacing the origin with `BETTER_AUTH_URL`:

```text
https://shiba.example.com/api/auth/callback/sso
```

Discovery uses `<SSO_OIDC_ISSUER>/.well-known/openid-configuration`. A disabled flag or incomplete settings hides the sign-in button. `/api/setup/status` reports an `sso` entry with configured and missing setting names; it never returns credential values. When the flag is on, the setup doctor also reports incomplete configuration.

## Account and workspace policy

Only email addresses in `SSO_ALLOWED_DOMAINS`, or the bootstrap owner's email, can sign in through SSO. Domain matching is exact and ignores case: allowing `example.com` does not allow `other.example.com`. With no allowed domains, only the bootstrap owner can use SSO.

The provider must return a signed ID token with `email` and `email_verified: true`. Shiba also requires the existing local account to have a verified email. Providers without that verified email claim need a reviewed claim-mapping integration before they can be used.

This first version signs in and links existing accounts. Create the bootstrap owner through the existing setup flow. Other people must enroll using a workspace invitation and verify their email before using SSO. They still review and accept the workspace invitation separately. SSO does not grant workspace administration or deployment administration.

`SSO_AUTO_JOIN` is reserved and has no effect in this version. Automatic account creation and automatic workspace membership are follow-up work. Keep using the [team invitation flow](/docs/team-workspaces/).

## Identity provider examples

All examples use the redirect URI above and an authorization code application with a client secret. Restrict the application to your company's users in the identity provider as well as configuring Shiba's domain policy.

### Okta

Create an OIDC **Web Application**, enable the authorization code grant, and assign the intended users or groups. Use the issuer from the authorization server, for example `https://your-company.okta.com/oauth2/default`, as `SSO_OIDC_ISSUER`. Copy the application's client ID and secret into the corresponding Worker settings. See [Okta's issuer guidance](https://support.okta.com/help/s/article/use-of-the-issuer-located-under-the-openid-connect-id-token-app-settings).

### Google Workspace

Create a web application OAuth client in Google Cloud, add the redirect URI, and configure the consent screen for your organization's users. Set `SSO_OIDC_ISSUER=https://accounts.google.com`, then supply the client ID and secret. Set `SSO_ALLOWED_DOMAINS` to your Workspace email domains; selecting an internal consent screen alone does not replace Shiba's domain check. See [Google's OIDC guide](https://developers.google.com/identity/openid-connect/openid-connect).

### Microsoft Entra

Register an application for your tenant and add a **Web** redirect URI. Create a client secret and use the application client ID. Set the issuer to `https://login.microsoftonline.com/<tenant-id>/v2.0`; use your tenant ID rather than the `common` endpoint. Entra does not normally supply `email_verified`. This core version requires that claim, so the tenant URL below is a configuration reference; a reviewed verified-email mapping is follow-up work before Entra sign-in can be used. See [Microsoft's OIDC guide](https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc).

### Authentik

Create an OAuth2/OIDC provider and an application, select authorization code flow, and set the exact redirect URI. Use per-provider issuer mode and set `SSO_OIDC_ISSUER=https://auth.example.com/application/o/<application-slug>/`. Copy the provider's client ID and secret, and include its `openid`, `email`, and `profile` scope mappings. See [Authentik's OAuth2 provider guide](https://docs.goauthentik.io/add-secure-apps/providers/oauth2).

## Verify sign-in

Check `/api/auth/social-providers` for `sso.enabled: true`, then use **Continue with Company SSO** (or your configured display name). Test an allowed account and a disallowed domain. With the flag off, the endpoint reports `sso.enabled: false` and the button is hidden.

A live round trip needs a real identity provider and its registered application. Mocked issuer tests prove protocol handling, but do not prove your provider's user assignments, claim mappings, or deployed redirect URI.
