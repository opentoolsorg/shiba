# Team skills and saved first task setup

Team membership uses owner, admin and member permissions. Employee occupations such as finance, HR and engineering do not change those permissions.

## Skills

The selected workspace's Skills view has two existing instruction paths:

* Run-attached skills use `/api/skills`. Owners and admins may install a curated template into their workspace as an owned draft, edit an owned skill using its expected version, inspect history and explicitly review, activate or disable it. Editing creates a new draft version and requires review and activation again. Another member can read only an explicitly active shared version, not the owner's draft history.
* Team instruction skills reuse `/api/v1/extensions/skills`. The selected workspace is resolved from the verified session and current membership, not a submitted organization ID. Members can read shared skills. Owners and admins may create and manage shared instructions; another person's personal instructions remain private. Team creation is disabled by default and refuses `enabled: true`; enabling is a separate action after review. Updates require `expectedVersion`. Every team mutation checks the active manager role and exact membership grant version inside its conditional database write; reads recheck membership and role after awaited storage work. Disabled or archived instructions stay unavailable to runtime instruction tools.

Managed installation keeps the existing draft-then-receipt contract. Draft creation and its version are transactional; the install receipt has its own guarded conditional write. Removal between those committed steps can leave an unlinked inactive draft. Later writes are refused, and no instructions are automatically activated.

Installing or enabling instructions grants no connector access, tool permission, provider connection, budget, schedule or run approval. The existing employee runtime still controls whether a selected skill is available to a turn. Native invited-user execution remains subject to the separate provider and billing contract.

Reserved `team:` organization names do not establish service-token authority. API-key and inbound MCP skill reads without a current native workspace membership are denied. Ordinary non-team organization API and MCP skill paths retain their existing contracts. Team Spaces are unavailable until they have a scoped mutation contract; team rooms remain the supported shared-work surface.

The browser uses explicit workspace headers and keyed actor/workspace components. Workspace changes abort pending reads and discard prior local forms. Permission failures remove cached team instructions instead of opening a personal-workspace fallback.

## Saved team setup

The Work view offers **Set up a team task** to native email-session users. This uses the existing onboarding progress schema and conditional revision writes, stored under a server-derived tuple of team organization and immutable account ID. Each person has a separate draft in each workspace. Initial creation and save, step, dismiss and resume writes check the exact active membership role and grant version in SQL. Reads, including conflict responses, recheck the grant after storage work.

Goal, audience, acceptance, supplied context, role, saved employee and app requirements can be saved and resumed. Optional fields may stay blank. Employee IDs are checked against the selected team's current employee version. The route rejects private source IDs and does not read private Memory, provider status, private run history or accepted-deliverable evidence.

These drafts are planning records. They have no executable prepared token. `/prepare-task` responds with `team_draft_requires_room_approval`. **Review saved task in team rooms** saves and reads the exact owned draft version/revision, then stages a short-lived snapshot for explicit room-composer review. Existing unsent work requires replacement confirmation; copying submits no task and grants no execution. The user chooses current shared sources and an employee, then requests the normal frozen human approval. Later setup edits do not update a copied task, and the run does not inherit a personal prepared-task reference. See [the snapshot and review contract](team-onboarding-task-transfer.md). Cloudflare Access users without a native email session do not have this saved setup identity contract.

## Verification boundary

`apps/backend/test/team-skills-onboarding.test.ts` exercises the real route and store implementations against SQLite-backed D1 fixtures. It covers workspace separation, private instruction isolation, owner/admin/member permissions, removal, draft installation, stale edits, current employee versions and per-account onboarding drafts. Browser component tests cover scoped setup requests, conflicts, removal, workspace switching, delayed save/reload/configure completions, modal keyboard containment and deliberate draft installation. These are local tests with fixture authentication and HTTP responses, not live Cloudflare, Slack, provider or third-party account acceptance.
