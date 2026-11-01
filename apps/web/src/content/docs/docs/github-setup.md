---
title: GitHub setup
description: Configure repository access, pull request publishing, and verified GitHub events.
---

This guide is for the person running the Shiba installation. For everyday use, see [GitHub](/docs/github/).

## Repository access

Accept only HTTPS URLs for `github.com`, without embedded credentials. Use the repository's actual base branch. Public diff-only work can run without `GITHUB_TOKEN`; private repository access requires a token authorized for that repository.

Set the token through your chosen deployment secret configuration. It stays in the Worker. The GitHub egress handler adds authentication only for the repository approved for the run; it refuses unapproved or out-of-scope repository paths. Never place the token in a clone URL, task, container environment, or log.

Validate private cloning against a test repository in your own deployment. A configured token alone is not evidence that access works. See [Security](/docs/security/) and [Configuration](/docs/configuration/).

## Pull request publishing

Publishing is off by default. A requested publish run requires `GITHUB_TOKEN`. Use a fine-grained token restricted to the intended repositories, with the permissions needed to read repository data, write contents, and create pull requests, subject to organization policy.

The Worker creates the commit, branch, and pull request through GitHub's API. The token is not sent to the container. Publishing does not merge the pull request.

### Fidelity limits

The publisher uses captured file contents and captured deletion entries, rather than transporting an arbitrary Git patch. Capture is bounded and published file entries use mode `100644`. Review renames, executable bits, binary changes, and large results before merging. An empty captured change set fails with “Nothing to publish”.

An API failure can leave commits or a branch behind. Inspect the target repository before retrying a failed publish.

## Webhooks

Configure GitHub to send the selected events to:

```text
https://your-shiba.example.com/api/github/webhook
```

Set `GITHUB_WEBHOOK_SECRET` on the Worker and use the same value in GitHub's webhook secret field. Keep it out of the webhook URL. Delivery must reach the handler through your deployment's access configuration.

The handler verifies the signature, requires a delivery identifier, rejects replayed deliveries or payloads, and forwards accepted events to configured automations. Missing configuration or unavailable replay protection returns an error for retry. A valid delivery alone does not create permission for arbitrary execution.

Configure the matching event and repository in [Automations](/docs/automations/). See [API reference](/docs/api/#github-webhook) for request requirements and [Readiness](/docs/readiness/) before a live rollout.
