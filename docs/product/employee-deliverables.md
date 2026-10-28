# Role-based Bots and required deliverables

Bots can prepare code, marketing drafts, research reports and operations
runbooks in an approved repository. Role starters configure editable Bot
instructions and required files. They do not connect an account, start a task,
or publish anything when selected.

The Marketing repository workflow has passed browser and sandboxed Linux
Electron acceptance with a deterministic model CLI fixture
(`liveInference: false`). This verifies role setup, approval, file capture,
download and failure handling, not live model inference or campaign quality;
the [acceptance audit](../audits/employee-deliverables.md) records the details.

## Create and run a Bot

1. Open **Bots** and choose **Engineering**, **Marketing**, **Research** or
   **Operations** under **Start from a role**. Review the draft name,
   instructions and required deliverables. If the draft already has role
   content, choose whether to keep or replace it; use **Edit bot** for a saved
   Bot.
2. Review **Harness**, **Model**, **Model connection**, **Sandbox** and
   **Default repository**. Use a supported harness and an actual repository
   where the work belongs. For local execution, pair a computer and
   authenticate its supported CLI. Click **Create bot** to save the reviewed
   configuration.
3. Click **Launch bot** and describe the outcome, supplied facts and success
   criteria. The composer shows the selected Bot's required files. Select
   **Local (Paired computer)** and its computer, or **Cloud (Sandbox)**.
4. Send the task, inspect its frozen approval payload and approve it. Grant
   any additional tool permission only after reviewing that request.
5. Open the completed run's **Deliverables** section. Download the captured
   files, inspect their content and check the evidence supporting their claims.
   The same version remains available when you reopen the conversation.

| Starter | Required files |
| --- | --- |
| Engineering | No fixed output path; code locations depend on the task. |
| Marketing | `marketing/brief.md`, `marketing/campaign.md` |
| Research | `research/report.md`, `research/sources.json` |
| Operations | `operations/runbook.md` |

The starters preserve the harness, model, connection, sandbox and repository
already selected in the new-Bot form. Instructions and required files remain
editable before saving. Use **Required deliverables** to enter one path per
line; clearing the field removes the requirement from the saved configuration.
Each queued task keeps the required paths frozen into its approval.

## What the file checks establish

Requested files must be complete, nonempty UTF-8 text files. JSON outputs must
also parse. Each file can contain at most 16 KiB and the requested set at most
64 KiB. Up to eight unique relative `.md`, `.txt`, `.json` or `.csv` paths are
supported. Hidden paths, parent traversal and duplicate names that differ only
by case are refused.

Missing or invalid required files fail the run. A partial set does not become
a completed deliverable bundle. Downloaded content is checked against its
recorded byte count and SHA-256 digest. Capture checks do not establish factual
accuracy, campaign effectiveness, correct research conclusions or a safe
operational procedure. Review those against the goal and underlying evidence.

Downloads require the same authenticated owner and conversation as the run.
The retained files remain available from that run after refresh. Only requested
outputs are retained as downloadable deliverables; ordinary run/list responses
carry file metadata rather than document bodies.

## Current scope

These are repository-based draft workflows and a bounded role-artifact increment
toward the combined product goal of Viktor-like AI employees in an Overlay-like
shared workspace with bot collaboration. Use a real approved content or project
repository; general business workspaces, shared goal/task ownership and scoped
bot handoffs remain part of the [larger employee goal](ai-employees.md). Role
instructions do not grant a Bot new browser, mailbox, social, CRM or analytics
permissions.

The Marketing journey was exercised in both browser and sandboxed Linux
Electron, with 14 UI steps and 18 protocol checks on each target. The tests
used a deterministic CLI fixture and recorded `liveInference: false`. They
confirmed that missing required files fail the run and expose no partial
download bundle. This is bounded repository-draft acceptance, not evidence of
live model inference, semantic accuracy, campaign effectiveness or the full
Marketing employee workflow. Research and Operations have repository templates
and required outputs, but their role-specific journeys have not passed the same
acceptance. The [acceptance audit](../audits/employee-deliverables.md) records
the detailed checks, limitations and retained evidence.

Writing a campaign, reply draft or runbook does not post content, send mail,
create a schedule or deploy software. Those actions need their own supported
connection, destination, authorization and result verification. The required
files mechanism provides inspectable outputs for review; full employee and
reference-product parity remain separate acceptance work.
