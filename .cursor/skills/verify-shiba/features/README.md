# verify-shiba features

Drive these from the real dashboard UI at http://localhost:$PORT/app/.

| Feature | What it proves |
| --- | --- |
| task-submit-and-approval | Composer submit produces an approval card; reject starts no container |
| sandbox-run-and-diff | Approve starts one sandbox; run status and diff appear |
| pr-publish | Approved publish run opens a PR (live repo or mock GitHub) |
| review-findings | Chained reviewer posts one COMMENT review; findings list matches |
| run-registry-status | Runs view shows status chips and registry counts |
| review-lifecycle | Finding triage PATCH, PR merge approval request (mock GitHub in cloud stand-in) |

When SHIBA_TEST_REPO is unset, GitHub-touching journeys run in mock boundary mode and must be labeled mock GitHub. That is not live proof.
