---
title: Email
description: Email a task to a Shiba mailbox. Approval still happens in the dashboard or Slack.
---

You can send Shiba a task by email. Write to one of your installation's mailboxes, such as `dev@your-company.example`, put the task in the subject or body, and include the GitHub repository it's about. Shiba replies with an approval number. Nothing runs until an approver accepts the request in the dashboard **Approvals** list or in Slack.

## Send a task

1. Write a new email to a Shiba mailbox from an address your administrator allowed.
2. Describe the task in the subject, the body, or both. Shiba joins them, and drops quoted history and signatures below your message.
3. Include a link like `https://github.com/owner/repo`. You can leave it out if your administrator mapped the mailbox to a repository.

Shiba replies in the same email thread with the approval number and, when the dashboard hostname is configured, a link to Shiba. The dashboard shows the full input. If something is missing, such as the repository, the reply explains what to add and nothing is queued. Shiba uses plain text for intake and doesn't pass attachments to the run. Keep the subject and body to 4,000 characters.

## Approval never happens by email

Email is easy to forge, so Shiba never treats an email as a decision. Replying "approve", "yes", or "LGTM" doesn't approve anything. Shiba answers that email can't decide and leaves the request pending. Any other reply in the thread counts as a new request that needs its own approval.

An approver decides in one of two places:

- **Dashboard**: the request appears in **Approvals** with the full task. Only people on `DASHBOARD_APPROVERS` can decide it.
- **Slack**: when `SLACK_APPROVALS_CHANNEL` is set, an approval card is posted there. Only people on `SLACK_APPROVERS` can press its buttons.

After approval, the selected employee runs the task. Progress and results are in the dashboard, and the email request doesn't ask Shiba to publish a pull request.

## Set up email intake

This part is for your installation administrator. Email intake is off until you configure it.

1. Set up inbound mail first: route each address to the Worker with Cloudflare Email Routing and register it as a mailbox, as described under **Agent mailbox** in [Launch](/docs/launch/). Replies go out through the `SEND_EMAIL` binding; without it, requests are still queued but senders get no reply.
2. Map each task mailbox to a saved employee in this installation with `EMAIL_TASK_EMPLOYEES`, for example `{"dev@your-company.example": "engineering"}`. Use the employee ID or slug. Other registered mailboxes still only receive ordinary mail.
3. Set `EMAIL_TASK_SENDERS` to a comma-separated list of exact sender addresses, such as `alice@your-company.example,bob@your-company.example`. Leaving it empty turns task intake off.
4. Optionally set `EMAIL_TASK_REPOS` to a JSON map from mailbox address to repository, for example `{"dev@your-company.example": "https://github.com/owner/repo"}`.
5. Make sure `DASHBOARD_APPROVERS` (and `SLACK_APPROVERS` if you use the Slack card) names the people who should decide. Sender allowlisting lets people request work, not approve it.

### Which mail is accepted

Shiba queues a request only when all of these are true:

- The mail was delivered to a registered mailbox and stored in its inbox.
- The first `Authentication-Results` header, the one Cloudflare's receiving server (`mx.cloudflare.net`) adds, says `dmarc=pass` and at least one of SPF or DKIM passes. Later results are ignored. DMARC authenticates the domain; it does not identify an individual.
- The single From address matches the SMTP envelope sender and is on `EMAIL_TASK_SENDERS`. Forwarded mail or mail that uses a different bounce address may only go to the inbox.
- The mail isn't automated: auto-replies, mailing-list mail, and bulk mail are skipped so Shiba never answers a machine.

Mail that fails any of these checks stays in the inbox as ordinary mail and gets no reply, so Shiba can't be used to send mail to people who never wrote to it. A redelivered copy of the same message never queues a second request.

### Test it

Send a small request from an allowed address. Check that the reply arrives in the same thread, that the request shows in **Approvals** with the exact task, and that replying "approve" leaves it pending. Then reject it in the dashboard and confirm no run starts.
