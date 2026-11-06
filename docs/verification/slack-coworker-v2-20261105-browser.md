# Slack coworker submission: offline browser evidence

On 2026-11-05, Chromium exercised the actual `SlackCoworkerPanel` and `PersonalExecutionSetup` components in a local Vite fixture. The fixture supplied synthetic native account, computer, grant, Slack draft, room, employee, preview, and receipt responses. All non-local browser requests were blocked. No Slack account, provider, task execution, native approval, or real navigation was used; the navigation callback recorded a fixture marker.

- [Desktop selection](slack-coworker-v2-20261105-selection-desktop.png): selected fixture room, employee, and personal account grant.
- [Desktop preview](slack-coworker-v2-20261105-preview-desktop.png): exact fixture statement, audience, and nonsecret execution snapshot before consent.
- [390px preview](slack-coworker-v2-20261105-preview-390.png): reviewed disclosure at narrow width. Document width and scroll width were both 390px.
- [390px queued receipt](slack-coworker-v2-20261105-queued-390.png): synthetic queued receipt and open-handoff control. Clicking it invoked the fixture navigation callback.

The browser reported no uncaught page errors. These observations verify rendering and the mocked client interaction only; they do not verify live Slack, personal account entitlement, backend authorization, or actual execution.

## Private status consent (offline fixture)

A second local Chromium pass used synthetic private-status target metadata and blocked all external hosts. The [390px consent screenshot](slack-coworker-v2-20261105-private-consent-390.png) shows the fixture Slack user, team, channel, thread, expiry and six-notice cap alongside a separate unchecked opt-in. The document and scroll widths were both 390px, with no uncaught page errors. This is mocked component evidence; no Slack status was sent and it does not verify live delivery.
