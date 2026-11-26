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
| S1 | [Pricing – Linear](https://linear.app/pricing) | Linear seat pricing + free-tier limits |
| S2 | [Jira pricing: Free, Standard, Premium, Enterprise \| Atlassian](https://www.atlassian.com/software/jira/pricing) | Jira seat pricing + free-tier limits |
| S3 | [Cycles – Linear Docs](https://linear.app/docs/use-cycles) | Linear cycles documentation |
| S4 | [What is a sprint? \| Jira Cloud \| Atlassian Support](https://support.atlassian.com/jira-software-cloud/docs/what-is-a-sprint/) | Jira sprint documentation |
| S5 | [Jira review: Rovo agents, pricing and Linear — Software Lifecycle](https://www.software-lifecycle.com/sites/jira) | Dated third-party pricing comparison |

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

## Run the local research-room fixture

With the repository's pinned Node and pnpm versions, run from the root:

```sh
pnpm install --frozen-lockfile
node --test apps/backend/test/acceptance/research-room-fixture.test.mjs
```

The test builds the dashboard, initializes a fresh loopback Worker with temporary
D1 and Durable Object storage, then creates a workspace, two signed-in teammates,
room citations, and an evidence-to-brief handoff. It seeds only the invited
reviewer's verified account record directly because local email is disabled;
workspace invitations, sign-ins, handoffs, results, and review decisions use
the real APIs. Nothing reuses a database, credentials, or a saved session.

For browser automation, import `startResearchRoomFixture` from
`apps/backend/test/acceptance/research-room-fixture.mjs`. It returns the
`roomUrl`, two disposable sign-in identities, and `revise()`, which creates a
new room handoff after the reviewer requests changes on the first brief. Use
separate browser profiles and call `stop()` to remove the fixture state.
The two briefs are distinct immutable handoff artifacts, not in-place edits.

The local adapter returns prewritten Markdown based on the
[dated evidence](evidence-collection.md); it does not run a model. Live model
generation and verification email delivery are not covered. The fixture does
not deploy, publish, or require provider credentials.
