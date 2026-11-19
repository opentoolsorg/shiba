---
title: Agent cloud computer
description: Watch and temporarily control the desktop of an approved cloud run.
---

A cloud computer is a temporary Linux desktop in one approved Cloudflare sandbox run. It has a browser and starts only when the run starts. The desktop, browser profile and unsaved files are destroyed with the sandbox; it never stays on between runs.

## Request and approve a computer

1. In a private task thread, choose **Cloud** and enable **Cloud computer** before sending your task.
2. Review the task and its **Uses a cloud computer** label on the approval card. Approve the run to start it. The desktop setting is part of the approval, so it cannot be added silently later.
3. Open **Computer** on the running task. The view samples the screen about every two seconds when open. It isn't a video stream or a recording.
4. Select **Take over** to send input, and **Release control** to hand it back. The agent's screen tools pause during takeover. With no screen refresh from the controller, control expires in about a minute. Takeover pauses screen tools only, not the agent's other work.

Only a person authorized to see the run can open its screen or take control. Takeover and hand-back appear in the run's receipts. Live frames aren't saved automatically. Explicit agent screenshots can appear as private files in **Outputs**. Chat asks for confirmation before agent clicks, typing or key presses. Inside the sandbox, the approved run's desktop helper coordinates control; takeover isn't an isolation boundary against code running in that sandbox.

## Network and credential limits

The desktop doesn't grant Internet access beyond the hosts selected for the approved run. The sandbox denies other outbound traffic. GitHub access is still limited to the approved repository, and Shiba attaches model and GitHub credentials at egress, not in the desktop. The browser starts with a fresh profile and no saved logins.

Don't type passwords, access tokens, recovery codes or other secrets into the desktop. The screen is visible to authorized run viewers, and the cloud computer isn't a password vault. Use [Connections & tools](/docs/connections/) for accounts that require credentials. The cloud computer is unavailable in shared rooms, on other sandbox providers, or when per-run environment variables or deployment-wide extra egress hosts or environment passthrough are configured.

The sandbox image includes Xvfb, a lightweight window manager and Chromium. The desktop layers added about 371 MB compressed in a local amd64 build. All cloud runs use the larger image, but the desktop processes start and use container CPU and memory only for opted-in runs. Container and storage charges still follow the [runtime costs and limits](/docs/runtime-limits/).

## Other ways to use a computer

- A **shared computer** is a separately reviewed, offline desktop for people. It never attaches to a run or accepts agent input.
- A [paired computer](/docs/remote-access/) is your own machine running a Shiba daemon. The cloud computer doesn't connect to your machine or use its logins.
