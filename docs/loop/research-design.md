# Research design — two-product comparison (acceptance case)

Scope for the room demo only. The question is deliberately small so the
stopping rule is reachable in one research pass.

## The question

> For a five-person product team choosing an issue tracker in 2026, how do
> Linear and Jira compare on (a) starting price per seat, (b) the free tier's
> limits, and (c) built-in cycle/sprint tracking?

Three claims maximum per product dimension. A marketer can check every claim
in minutes.

## Approved sources (the collection the room pins)

Each source is pinned into the room as a shared note (versioned + sha256) so
the frozen context survives reload and revocation checks:

| # | Source | Role |
|---|--------|------|
| S1 | linear.app/pricing | Linear seat pricing + free-tier limits |
| S2 | atlassian.com/software/jira/pricing | Jira seat pricing + free-tier limits |
| S3 | linear.app/docs/cycles | Linear cycles documentation |
| S4 | support.atlassian.com/jira-software-cloud — sprints | Jira sprint documentation |
| S5 | Third-party comparison article (dated) | Conflict source — used to show a visible disagreement |

Sources are public pages captured into notes with their retrieval date. No
paywalled or login-gated source is allowed; the acceptance wants the reviewer
to be able to open every source.

## Stopping rule

Stop collecting when every row of the claim table has at least one approved
source, OR after 12 source reads, whichever comes first. Anything still
uncovered at the cap is recorded as a missing source, never invented.

## Evidence record (the brief's per-claim shape)

| Field | Meaning |
|---|---|
| `claim` | One checkable sentence, e.g. "Linear's free tier covers 250 issues." |
| `excerpt` | The verbatim source passage the claim rests on (≤ 40 words) |
| `source` | `S1`–`S5` id + URL + page title |
| `date` | Retrieval date of the pinned note |
| `uncertainty` | `supported` | `conflict` | `missing`; conflicts and misses stay visible |

A claim is only `supported` when its excerpt literally states it. Two sources
disagreeing produces two records with `conflict`, never a silently merged
number.
