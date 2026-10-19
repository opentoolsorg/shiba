# verify-shiba features

Drive these from the real dashboard UI at http://localhost:$PORT/app/.

| Feature | What it proves |
| --- | --- |
| core-loop-mock | Mock GitHub: submit → approve → run completes → PR in stub → review posted → round `posted` (CI default) |
| task-submit-and-approval | Composer submit produces an approval card; reject starts no container |
| sandbox-run-and-diff | Approve starts one sandbox; run status and diff appear |
| pr-publish | Approved publish run opens a PR (live repo or mock GitHub) |
| review-findings | Chained reviewer posts one COMMENT review; findings list matches |
| run-registry-status | Runs view shows status chips and registry counts |
| sandbox-sdk-1-migration | Phase 2a SDK 1.0 DO + outbound handlers; reuse sandbox-run-and-diff |
| browser-e2e-evidence | Publish run stores E2E frames + manifest in R2; PR body links manifest |
| review-lifecycle | Finding triage PATCH, PR merge approval request (mock GitHub in cloud stand-in) |
| phase5-integrations-automations | Integrations Linear row; Slack verify + GitHub status probes (mock) |
| public-api-keys | Settings mints shk_ keys; OpenAPI at /api/v1/openapi.json |
| captain-subagents | Den snapshot API + subagent tree UI (Phase 2b; legacy captain paths aliased) |
| byo-models-ux | Settings Models: ordered connections, test connection, role pins; run usage when reported |

When SHIBA_TEST_REPO is unset, GitHub-touching journeys run in mock boundary mode and must be labeled mock GitHub. That is not live proof.
