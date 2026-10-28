# Bots: launch and acceptance

The [final recheck](final-recheck.md) records the latest results, including
multi-session permission rendering and local cleanup migration. Both web and
Electron passed the real-daemon journey with a deterministic model CLI.

The user-facing feature is named **Bots**. Existing `/api/custom-agents` URLs,
stored IDs, profile versions and session metadata remain compatible. A bot is
a saved set of instructions, harness, model, connection, repository and sandbox
settings. Each task still needs its own human approval.

## Launch a bot

1. Open **Bots** from the main navigation.
2. Enter its name, slug, instructions and default repository. Choose a harness
   and, when needed, a model and a ready provider connection. Click **Create bot**.
3. Click **Launch bot**. This opens a new thread bound to that bot. Existing
   threads can be reopened from its directory card.
4. Describe the task. For local execution, choose **Local** and a compatible
   paired computer; otherwise use the configured cloud runtime.
5. Click **Send task**, review the frozen task and bot version in **Approvals**,
   then click **Approve**. Queueing alone does not start execution.
6. Review progress, the result and diff in the thread. Local tool permission
   requests appear in the **Live agent session** panel and require their own
   decision.

Selected bots submit directly to the authenticated run API. They do not require
a separate chat-planner inference to queue their already configured task. The
server resolves the saved bot and freezes its version, instructions and route
in the approval. Editing the bot afterwards does not change that approved input.

Failed submissions show the error and restore the draft. Retrying an unchanged
task in the same thread and runtime retains its command ID. A different thread
or runtime is a distinct command. Archiving prevents new bot work and preserves
existing conversation history; restoring makes the bot available again.

The Worker derives each dashboard approval's thread from the authenticated
user/session, replacing any supplied thread key. Personal and named-thread
approval decisions stay on their owning store; they cannot fall through to a
shared queue. Local targets come from the authenticated computer list and must
be paired, recently connected and compatible with the bot's saved harness.
Multiple computers require a choice. An unavailable selection blocks sending
and does not switch the task to a different computer or cloud execution.

Review and pull-request panels carry the same named session as the bot run.
Responses from a previous thread cannot replace the current panel after a
switch. Unpublished local work can display its real diff without a false
"Run not found" review error.

The diff viewer uses the retained Git patch before any legacy tool-summary
fallback. The fallback excludes trailing result-envelope metadata while keeping
real patch lines intact. Both UI targets verify exact displayed-patch equality;
the web target also downloads the actual `.diff` and compares its bytes with
the persisted patch.

## Execution boundaries

The selected laptop platform is macOS. Cloud verification executes on Linux.
The macOS workflow is prepared, but native Mac installer execution, signing and
notarization are not established by Linux results.

There is no ready model connection in the current development instance. Browser
cloud-runtime checks use the explicitly declared execution stand-in and mock
GitHub. Local-runtime checks use a deterministic Claude-protocol fixture CLI;
the Worker, daemon, native Git, tool approval, file edit and persisted diff are
real. Neither fixture is proof of live model inference.

Local execution is enabled in this instance's ignored development configuration.
The main paired-computer API is available and currently lists no computers. For
a live local Claude/Codex run, pair the real computer and authenticate its CLI
securely on that computer; do not paste credentials into chat. The setup draft
preserves this local-runtime opt-in and generates a pairing secret only when
absent, without recording secret values in the draft.

## Final verification on 2026-10-28

| Check | Result and boundary |
| --- | --- |
| Full repository tests | **3,148 passed, 3 credential-dependent tests skipped**; all 8 workspace tasks passed. |
| Typecheck/build/CI/import/deployment drift checks | Passed; CI retains documented warnings and existing Knip findings within its threshold. |
| Web bot/thread and mock execution gate | **31 checks passed:** 11 core-loop, 9 bot/thread, 11 Bot lifecycle. The affected 11 were refreshed after the final panel-routing fix. Execution is synthetic and GitHub mocked. |
| Electron Bot lifecycle | **11 checks passed**, including real composer retry, human approval, frozen bot version, scoped review/PR panels and archive/restore. Linux; synthetic cloud execution. |
| Real Worker and local daemon, browser | **9 UI steps + 12 protocol checks passed**, including actual approval-gated Git/file edits, saved diff and cancellation. Only model CLI is a fixture. |
| Real Worker and local daemon, Electron | **9 UI steps + 12 protocol checks passed**, with the same actual file/diff/cancellation path and native renderer isolation. Linux; only model CLI is a fixture. |

Evidence and screenshots: `.verify/agent-lifecycle/`,
`.verify/desktop-agent-lifecycle/`, and `.verify/local-daemon-e2e/ui-{web,desktop}/`.
Logs: `/tmp/shiba-bots-final-{tests,typecheck,build,check-ci,imports,built-test,deploy-check}.log`,
`/tmp/shiba-scoped-bots-{web,desktop}.log`, and `/tmp/shiba-ui-local-{web,desktop}.log`.
These are ignored local artifacts; the drivers and this report are saved with
the workspace changes. Test Workers and daemons were stopped; the main
development workflow is retained running with the local-runtime feature enabled.

The environment configuration draft also retains the reusable setup. Saving a
draft does not apply or publish it; review/save the environment settings and
publish the environment to activate that version. Native macOS acceptance and
live inference remain outstanding.
