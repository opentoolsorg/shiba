# Seba — reverse-engineering dossier (Tasklet × OpenBot × REA)

Research date: 2026-11-20. Sources: tasklet.ai (live site), github.com/nightly-labs/openbot
(source, PolyForm Noncommercial), openbot.run, rea.tools methodology.
Shiba evidence: `packages/shared/src/custom-agents.ts`,
`apps/backend/src/{collaboration-*,team-model-store,automations*,channels/,shared-computer-*}`,
`apps/frontend/src/{employee-templates,onboarding-journey,app-navigation}.ts`.

This document is the planning artifact for turning Shiba into a Tasklet-style
"team of AI employees" product around a main employee persona, **Seba**.

---

## 1. Tasklet — what it actually is

Verified from tasklet.ai (homepage, /pricing, /new sign-in page).

### Product model

- **Employees are the unit.** Each agent is a named hire with a job title
  (Accounts Payable Clerk, Client Analyst, Support Agent, Field Ops Assistant,
  Recruiting Coordinator, Executive Assistant), a work **email address**
  (`ap@acme.com`), a **phone number**, and a **reports-to** human manager.
- **Multi-channel presence.** Humans reach an employee where they already work:
  Slack @mention, Teams, CC'd email, SMS. Customers, candidates, and vendors can
  write to the employee directly — no account needed. Group threads mix humans
  and several agents; each agent answers for its own job.
- **Proactive, not request/response.** The marketing spine is a 24h timeline of
  agent work: *triggered* ("when something happens" — urgent ticket escalated,
  new order), *scheduled* ("on a schedule" — daily cash report), and
  *loose-end chasing* (chase Dana for a receipt, nudge a stalled deal).
- **Approval-gated external actions.** Payments, refunds, client sends need a
  person's OK; the approval card carries the exact action, amount, context and
  approver name.
- **Chat-created automations.** "Do this every Monday" mints a recurring
  automation in the reply.
- **No-code onboarding.** Connect apps, chat with the agent, or talk live and
  share your screen. No developer needed.
- **Per-agent computer.** "Each agent has its own isolated cloud environment"
  with its own permission boundary; credentials in an encrypted vault.
- **Business model.** Org-level credit pool, no per-seat fees, free tier,
  $25–$10k/mo tiers, model + reasoning level selectable per thread.

### What the landing page teaches about framing

- Sell *headcount*, not features: "Hire a specialist for every role."
- Show, don't tell: every section is a chat transcript ending in an approval
  card or a created automation.
- The org chart visual (name → role → email → phone → reports-to → online) is
  the product's front door.

## 2. OpenBot — what it actually is

nightly-labs/openbot (~9.4k★, ships near-daily). Local-first desktop workspace
for persistent AI teammates. Electron + SolidJS + Bun + SQLite locally;
Cloudflare Workers + D1 for accounts. Mobile apps pair to your machine.

### Mechanisms worth porting

| Mechanism | How OpenBot does it | Shiba today |
|---|---|---|
| Agent persistence | Each agent = independent provider session + own workspace dir + own conversation; survives restart and provider switch | Custom agents persist config; runs are per-task, not per-agent-continuous |
| Agent-to-agent | First-class messaging, replies, reactions, file transfer between agents; "Ada gave the task to Linus" handoff events | collaboration-* + team-model rooms exist; handoffs exist between specialist agents inside a run, not between top-level employees |
| Shared channel chat | Multi-party channel with ONE task owner, explicit delegation, Stop/Resume/Reassign/Archive | Rooms + collaboration live routes exist; no single-owner/delegate control semantics |
| Queues | Per-agent FIFO, pause/resume/cancel, crash-safe persistence | Task queues exist in work model; per-employee queue semantics unclear |
| Workflows | Named multi-step flows: trigger → agent steps → approval step → reuse | automations-do + triggers exist; no composed multi-agent workflow object |
| Provider fallback | Agent moves to backup model at plan limit; note posted in chat | Frozen-route model pins per role; no automatic failover note |
| Channel surfaces | apps/{slack,discord,telegram}-app: one agent identity answers on each | channels/{slack,discord,teams,telegram,email} exist — broader than OpenBot |
| Local-first data | SQLite source of truth; cloud holds accounts/membership only | Cloudflare-native (D1/DOs) — different posture, fine |
| Onboarding | "Describe the agent you want in one prompt, check its instructions, save" | Journey: workspace→provider→employee→task→approval→result; role templates exist but no prompt-to-employee generation |
| UX feel | Slack-like channel list + chat; every action inline in the transcript | Dashboard is powerful but settings-dense (20+ nav items) |

## 3. REA methodology applied

rea.tools ships `rea-agents` (set up in this repo's dev env): give the agent
tools to inspect a program while it runs, then explain and rebuild features.
Two findings shaped this dossier:

1. *Inspect the running thing, not the marketing.* For OpenBot we read source
   (`src/main`, `apps/*-app`, `packages/contracts`) rather than the site; for
   Tasklet (closed source, Cloudflare Access gated) we can only read the
   public contract — the dossier marks every inference.
2. *Rebuild the rule, not the skin.* The porting targets are mechanisms
   (identity, queue, handoff, approval, schedule), not OpenBot's UI chrome.

## 4. Gap matrix — Tasklet model vs Shiba

| Capability | Tasklet | Shiba today | Delta |
|---|---|---|---|
| Employee record | name, title, email, phone, reports-to, online | CustomAgentConfig: name, emoji/look, roleTemplateId, instructions, harness, model | NEW fields: `title`, `reportsTo` (human or agent), `department`, `channelIdentities` (slack/discord/email), presence projection |
| Role catalog | per-field titles | 11 roleTemplateIds incl. engineering, marketing, sales, operations, finance | add `support` (and `it`/`tech` alias) |
| Hire flow | pick specialist → connect → work | custom-agents editor + onboarding journey | Hire UX: role → name/persona → channels → computer; "Seba" offered first |
| Roster | org chart with presence + reports-to | "Agents" view = flat agent list | NEW roster surface: directory grouped by department with up-next projection |
| Hierarchy | human manager + teammates; agents addressable in group threads | team-model funding contracts: employee assists a human in a room | NEW: `reportsToAgentId` → lead/support tree; threads grouped per employee |
| Boards | n/a (transcript-centric) | Work view: tasks + board + timeline | Devin-Boards-like: claimable tickets w/ prerequisites, claimed per employee |
| Per-employee computer | isolated env per agent | shared-computer runtime (PR #318) + per-run sandboxes | bind `primaryComputerId` per employee; reuse instead of fresh sandbox where safe |
| Channels | Slack, Teams, email, SMS | slack/discord/teams/telegram/email — MORE coverage | employee-as-self identity per channel (avatar/name/email addr) |
| Proactive | triggers + schedules + loose ends | automations triggers + run_when | per-employee "up next" projection + loose-end follow-up records |
| Approvals | exact-action cards w/ amount/approver | approval gate everywhere already | restyle card copy to employee voice |
| Billing | org credit pool | self-hosted; usage budgets exist | out of scope for launch |
| Group chat | humans + multiple agents in one thread | collab rooms support participants incl. agents | mostly exists; needs roster-driven addressing |

## 5. "Seba" — target product shape

- **Seba** is the default/main employee persona offered at first run: the
  generalist chief-of-staff that can do marketing, coding, sales, support,
  operations, finance, and tech — and hire specialists under it.
- **Departments**: marketing · coding · sales · support · operations ·
  finance · tech. Each hire gets a department; a department lead can have
  support agents; each employee's conversations group into its own thread
  space.
- **Surfaces**: web dashboard (roster-first), desktop app (existing pairing +
  "face" interface), Slack + Discord presence, boards.
- **North star UX** (from OpenBot): every employee interaction is a smooth
  channel transcript — messages, handoffs, approvals, automations all inline.

## 6. Phased plan to launch (~2 weeks)

- **P0 — Employee spine**: extend CustomAgentConfig (title, department,
  reportsTo, channelIdentities, primaryComputerId) + `support` role +
  roster API + roster UI + hire flow + Seba seed.
- **P1 — Boards + hierarchy**: claimable tickets w/ prerequisites on the
  existing work store; lead→support routing in rooms; grouped threads.
- **P2 — Presence + computers**: per-employee Slack/Discord identity;
  per-employee persistent computer binding; up-next projection.
- **P3 — Polish**: transcript-centric IA pass, onboarding depth
  (chat-to-hire), marketing site reposition (apps/web) toward Tasklet framing.

## 7. Not invented here

- No new store where an existing DO/D1 table extends (rooms, org_custom_agents,
  automations).
- No SMS/phone carrier work for launch — email + Slack + Discord suffice.
- No credit-billing clone — self-hosted keeps usage budgets.
- Approval semantics unchanged: Tasklet's model matches Shiba's existing gate.
