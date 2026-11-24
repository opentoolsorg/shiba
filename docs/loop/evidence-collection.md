# Evidence collection — Linear vs Jira (2026-11-24)

Records follow `docs/loop/research-design.md`. `S5` is the dated third-party
source; every claim below is verbatim-checkable against its excerpt.

| Claim | Excerpt | Source | Date | Uncertainty |
|---|---|---|---|---|
| Linear Free covers unlimited members, 2 teams, 250 issues | "Free for everyone — Unlimited members, 2 teams, 250 issues" | S1 linear.app/pricing | 2026-11-24 | supported |
| Linear's first paid tier is $10/user/mo billed yearly | "Basic — $10 per user/month — Billed yearly" | S1 linear.app/pricing | 2026-11-24 | supported |
| Jira Free runs up to 10 users at no cost, no time limit | "The Free plan runs Jira for up to 10 users at no cost, with no time limit" | S2 atlassian.com jira-editions | 2026-11-24 | supported |
| Jira Standard raises the site to 35,000 users and 250 GB storage | "User limit — Up to 10 users / Up to 35,000 users; Storage — 2 GB / 250 GB" | S2 atlassian.com jira/standard | 2026-11-24 | supported |
| Jira Standard's starting price per seat | — (official pricing page is JS-rendered; no readable figure) | S2 | 2026-11-24 | missing |
| Linear Free includes cycles | "Issues, projects, cycles, initiatives — Included" (Free column) | S1 linear.app/pricing | 2026-11-24 | supported |
| Jira Free includes sprint tracking via Scrum boards | "Every plan includes … Scrum and Kanban boards, backlogs" | S2 atlassian.com jira-editions | 2026-11-24 | supported |
| Third-party review prices Jira Standard differently than list | Software Lifecycle review (Nov 2026) reports sourced per-user figures "from … pricing pages, licensing FAQs and future price tables" | S5 software-lifecycle.com/sites/jira | 2026-11-24 | conflict |

## Independent source check (second assignment)

- S1, S2 are first-party vendor pages — authoritative for current list
  pricing/limits. Both retrieved today.
- S5 is a dated third-party review; its figures come from earlier price
  tables, so it is held as `conflict` where it disagrees with S2 — kept
  visible rather than merged.
- Unsupported claims: none invented. The Jira Standard seat price stays
  `missing` — the official page needs JS, and no approved secondary source
  gives a figure both parties agree on.
- One conflict kept visible: third-party per-seat figures vs the blocked
  official pricing table.
