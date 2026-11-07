# OpenConnector catalog browser journey — 2026-11-06

**Evidence label: FIXTURE.** Vite dashboard in Chromium; every `/api/*` response was intercepted. The catalog had 120 synthetic services and the consent page was synthetic. No Worker, deployed sibling, vendor, account or credential was contacted. This verifies browser behavior and rendering, not live upstream acceptance. Direct execute's fixture route returned the required 403; backend route tests independently verify the actual route contract.

| Journey | Result |
|---|---|
| Open Integrations → Connectors, browse catalog and display fixture totals | Pass |
| Filter `needs_configuration`; no Connect button | Pass |
| Filter ready, search, connect using fixture consent popup | Pass |
| Active account has no Reconnect; expired account can reconnect | Pass |
| Disconnect; direct execute remains 403 in fixture | Pass |
| 390px mobile catalog rendering | Pass |
| Browser page errors | 0 |

Screenshots: [full catalog](01-catalog-all.png), [configuration filter](02-filter-needs-config.png), [expired connection](05-expired.png), [390px mobile](08-catalog-390.png). Machine-readable report: [report.json](report.json).
