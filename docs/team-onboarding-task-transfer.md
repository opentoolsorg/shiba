# Review a saved team task in a room

A native team member can save a first-task brief and choose **Review saved task
in team rooms**. The app saves the answers, reads the exact accepted draft
version and progress revision, and stages a short-lived text snapshot. In a
currently readable room, Work opens once for review. **Use saved task in this
room** copies the text into the editable task composer. An existing unsent task
requires explicit replacement review and confirmation.

This action does not post a room message, submit a task, create approval, start
a process, select a credential or grant tools. The user still chooses the room,
employee, shared sources and supported execution route, then submits the normal
frozen human approval. Submitting can disclose the instructions to that room's
participants. The room review states this audience boundary before copying.

## Owned snapshot contract

`GET /api/onboarding/progress/team-task` requires a native cookie session and one
selected `X-Shiba-Workspace`. Its query contains exactly `draftTaskId`,
`draftTaskVersion` and `expectedRevision`. API credentials, absent native
sessions, ambiguous selectors and other users' or workspaces' records are
refused. The server derives the storage key from the team organization and
immutable native account UUID; callers cannot submit that key.

The response identifies the actor, account, workspace, exact saved version and
revision, text, optional current employee/version, save time and expiry. A final
SQLite statement checks the original membership role/version, verified native
account, actual session row/lease, exact saved bytes/revision and optional
employee availability/version together after preceding awaited reads. Actual
database expiry is checked synchronously before returning content. The lease
is no longer than the session or 15 minutes.

Private Memory/source references and prepared personal-task records cannot be
transferred through this endpoint. Complete text over 4,000 characters is
rejected, never truncated. Supplied context keeps the existing quoted untrusted
reference format. The API performs no source, provider, model or Slack request
and creates no new persistent record or executable token.

The browser checks the returned actor/workspace and exact accepted saved
reference, text and employee. Account/workspace changes abort old reads;
conflicts, unknown saves, changed references or expiry prevent staging. Room
adoption checks current readable room/actor and expiry again. Replacement
confirmation is bound to the exact incoming provenance, text, room and unsent
text, so changing them requires fresh review. The preview hides at expiry.

This is a data snapshot, not continuing authority or a live reference from a
run to the saved setup. After copying, text is independently editable; later
setup edits do not update it. The normal approval binds the final submitted
instructions and current employee/source/execution contracts. Previously seen
or copied text cannot be retracted by later revocation. The endpoint does not
enable the personal prepared-task API for team users.

## Evidence and limits

Focused backend tests use actual SQLite statements with fixture native auth.
They cover exact saved bytes, invited-member ownership, account/workspace
separation, stale revisions, conflicting selectors, automation denial,
membership/session/account/profile/source races, held-proof expiry and oversized
or private-source refusal. Component tests cover exact save/read verification,
late replies, conflicts, replacement, room selection and expiry. Source review
found no concrete blocker within this snapshot contract.

These tests do not establish deployed Cloudflare, installed identity/provider or
live multiplayer acceptance. Final-head aggregate checks are recorded on PR
#188. Preview remains paused, and no external messages or model runs were made.
