# PR 188 review and merge-readiness follow-up

This records source/test evidence, not approval to merge. Preview remains paused.

## Existing inline review threads

The read-only GitHub lookup found seven unresolved threads, six marked outdated.
Their source fixes are mapped below; no thread was resolved and no review was
approved by this work.

| Finding | Current implementation and regression evidence |
| --- | --- |
| Short environment fragments corrupt journal text | `opencode-agent.ts` applies fragment eligibility before multiline replacement; `opencode-agent-journal.test.ts` covers short and long fragments. |
| Redaction corrupts serialized structured observations | `readonly-agent.ts` redacts string fields before schema validation and serialization; `specialist-agent.test.ts` exercises structured output. |
| Artifact bearer tokens in query logs | New links use fragment landing and a bounded POST; `artifact-download.test.ts` checks that flow and intentionally retained legacy query expiry. This does not erase earlier logging exposure; legacy capabilities remain valid until their original bounded expiry. |
| Slack private destination saved without a bot token | `slack-routes.ts` requires both attachments and a nonblank bot token; `slack.test.ts` covers rejection. |
| Terminal truncation drops new output | `TerminalView` uses monotonic accumulated counts and epoch/overlap checks; terminal-output component and pure tests cover replay and retention. |
| Duplicated tabs share a viewer ID | Tab coordination completes before socket construction; `conversation-room-tabs.test.tsx` covers cloned storage and simultaneous tabs. |
| Artifact retry generates another workspace ID | The App retains the frozen command target across retries; `app.test.tsx` covers retry identity and new-draft/success transitions. The current helper marker alone does not establish a remaining caller defect. |

The reviewer executed 85 relevant backend and 48 frontend cases for these mappings.
These overlap the workspace suite and are not whole-PR review coverage.

## Aggregate follow-up

The first v3 aggregate run passed eight packages but failed forty backend cases.
The reviewed hotfix retains every source field in a newly consented compact JSON
Slack policy, leaves legacy Markdown bytes and the 3,500-byte cap unchanged, and
binds the original policy digest through final dispatch. Exact native-session
checks now guard Stripe human decisions, verification and private report output;
the standing scheduler remains independent of an open browser session.

The migration fixture now applies the appended budget index migration. Non-emitting
web/frontend typechecks no longer restore build directories from Turbo cache;
test pools are bounded without removing assertions or increasing default deadlines.
The stale generated-site cases passed after a fresh build. Local isolated affected
tests, security regressions and generated-source checks are separate from the final
aggregate and exact-head GitHub results.

## GitHub protection and approval

At the read-only snapshot, GitHub reported protected `main`, a constructible merge
and `mergeable_state: blocked`. The visible branch response listed no required
status contexts, and the visible ruleset collection was empty. The full legacy
protection read returned HTTP403, `Resource not accessible by integration`; its
approval count and other administrator-only settings could not be verified. It was
not retried through another credential or route.

The available review list contained a CodeRabbit `COMMENTED` review and no approving
review. Later broad automated review was skipped for size. An authorized maintainer
must assess the current commit, required checks, review resolution and protection
requirements; source/test mappings do not replace that decision. No merge,
approval, bypass, deployment or review-thread mutation was performed.
