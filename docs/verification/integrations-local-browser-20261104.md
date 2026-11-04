# Apps, skills and MCP browser acceptance: 2026-11-04

Ten final functional journeys passed against the actual production-built dashboard and local Worker. Separate visual inspection found mobile clipping; twelve subsequent component checks verified the responsive repair. This evidence does not establish live vendor, remote MCP, deployed Cloudflare or model execution.

## Revisions and environments

| Evidence | Revision | Scope |
| --- | --- | --- |
| [Functional report](./integrations-local-browser-20261104.json) | `c1c2e3086f2709046be5582e0fa966e610c6d90d` | Actual local Worker, production dashboard assets and production OpenConnector adapter. Selected source hashes matched before/after; served dashboard HTML hash is recorded. |
| Documentation checkpoint | `857c86bc1c6106a0e59afa3a62035d4361c25772` | Documentation-only descendant of the functional revision; runtime source was unchanged. |
| [Responsive layout report](./integrations-layout-browser-20261104.json) | `b79020b8365d714c76b923b9987ddeb88a54eb5f` | Actual production-built components and stylesheet with explicitly mocked, read-only metadata. CSS-only delta; no additional auth/vendor behavior claim. |

The functional stack used Wrangler `4.140.0`, local D1/DO/R2/KV, one genuine disposable first-owner signup and subsequent real password sessions. There was no second operator seed or positive browser two-owner test. The OpenConnector HTTP service and consent screens were synthetic fixtures; they enforced separate admin/runtime fixture tokens and used the production adapter paths. Provider setup used admin authentication.

Containers were explicitly disabled. Remote AI, Browser, Vectorize, email, service and container bindings were removed. No chat/task prompts or run approvals were submitted. Fixture vendor action calls and observed run/approval submissions were zero. No real vendor accounts or credentials, vendor consent terms, external messages, purchases or production resources were used.

## Verified functional journeys

1. Anonymous `whoami`, sessions, skills, workspaces and app-account requests returned **401**. Forged default identity headers gained no authority.
2. A controlled `window.open` returning `null` produced the real blocked-popup UI failure path and no authorization call. This is fault injection, not proof of browser popup-permission behavior.
3. Synthetic upstream authorization **503** closed the popup without creating an app account.
4. Explicit synthetic consent denial became retryable with no account or employee permissions.
5. An actual success-shaped callback page did not confirm consent without a matching owned account generation.
6. Disconnect → Browse → explicit synthetic Allow displayed verified success rather than the stale disconnected notice.
7. Inline Connect also updated after disconnect without manual catalog refresh/focus. Reconciliation required the new owned generation and exact authorization fingerprint, even when upstream reused its raw row ID.
8. Previously completed skill and founder changes survived fresh sign-in and build replacement: the disabled library skill was reinstallable, the founder bot remained archived, its instructions remained draft, and founder Deploy returned **409**.
9. Canonical MCP UI rejected a local HTTP destination with **403 `destination_not_trusted`**, leaving its registry empty. Public HTTPS restrictions were preserved.
10. Actual sign-out removed access: app accounts and skills returned **401**, with no cached synthetic account visible.

Earlier actual Worker/browser stages also exercised the complete general-skill sequence: install draft → review exact instructions → separate activation → active card → disable/reinstall-ready. Founder setup GET/preview created no employee; explicit digest-bound review imported an archived bot and draft skill with `unconfigured` requirements and `descriptions_only` routines. No schedule, connection, grant or active employee was installed automatically. The final retake verified those persisted states. These stages are described separately in the functional report; they were not model-driven executions.

Read-only inspection before deleting disposable D1 recorded: **1 user, 2 skills, 1 bundle import, 1 archived bot, 0 employee grants, 0 automations and 0 external MCP servers**.

## Mobile findings and repair

Document/body width checks alone missed clipping because the app shell hides overflow. The actual 390px screenshots showed header actions crossing the right edge and skill-card controls clipped offscreen:

- [Original Apps clipping](./integrations-before-app-390-dark-20261104.png)
- [Original skill-card clipping](./integrations-before-skills-390-light-20261104.png)

The CSS repair was checked in Chromium at **390, 768 and 1440px**, in light/dark themes. Element bounds covered header actions/copy, card regions, Install/Remove controls, founder actions and saved instruction blocks. At 390px the subtitle retained usable full width. All twelve checks passed, with zero page/console errors and no mutation requests.

- [Corrected Apps, dark](./integrations-layout-app-390-dark-20261104.png)
- [Corrected skills, light](./integrations-layout-skills-390-light-20261104.png)
- [Functional desktop account state](./integrations-functional-app-1440-light-20261104.png)

The corrected mobile screenshots are a labeled component fixture with mocked read-only data, not a second authenticated Worker acceptance run or a full accessibility audit.

## Diagnostics, cleanup and limits

The final functional run recorded **0 page exceptions, 21 console error entries and 8 warnings**. Logs are not globally clean: they retain expected negative HTTP responses, **7 unconfigured `/api/computers` 404 polls**, and SDK buffered/discarded-message warnings during identity/navigation changes. These warnings are not hidden and do not prove lossless CLI output or process recovery.

Harness corrections were kept distinct from product defects: the canonical revoked label is “Authorization unavailable”; MCP returns a machine-readable trust denial; and the signed-in account menu includes the fixture identity. Two actual UI defects, a stale reconnect notice and stale inline catalog state, were repaired and retested before the final pass.

Owned functional ports **8791/9391/9392** and visual port **9327** were stopped. Protected port **1040** remained available. Disposable D1, local auth/signing keys, fixture credential files, copied assets and the temporary visual harness were removed. Retained reports were checked/sanitized against the fixture secrets; screenshots contain synthetic data only.

Live vendor OAuth/actions, positive remote MCP, live email/Slack, deployed Cloudflare, provider/model runs, employee execution and positive browser multi-owner isolation remain outside this acceptance. Founder scheduling remains deliberately unavailable until its real prerequisites are configured.
