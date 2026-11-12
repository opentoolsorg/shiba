---
title: Files and revisions
description: Ask for useful files, inspect captured output, and turn review feedback into an approved revision.
---

An artifact is a file an AI employee produces for you, such as a launch brief, research note, checklist, or CSV. Use an **Artifact workspace** when the output does not belong in a GitHub repository.

## Choose the output before starting

Give the employee an audience, source material, and a clear definition of done. For example:

> Use the product notes supplied below to draft a launch brief for our sales team. Include the customer problem, three supported benefits, evidence for each claim, and open questions. Save it as `out/launch-brief.md`. Do not send or publish it.

There are two file paths through the product:

| Output | When to use it | Current limits |
| --- | --- | --- |
| **Named deliverables** | You need specific files whose presence can be checked. Enter their paths in the task's output-file settings. | Up to 8 UTF-8 `.md`, `.txt`, `.json`, or `.csv` files; 16 KiB each and 64 KiB combined. |
| **Artifact ZIP** | A cloud artifact workspace needs a collection of final files. You can leave the named-output list empty and ask for final files under `out/`. | Up to 64 files under `out/`; 1 MiB per file and 8 MiB combined, before ZIP overhead. |

Use safe relative paths, such as `out/launch-brief.md`, rather than absolute paths, hidden files, or `../`. File names must be unique even when capitalization is ignored. A local artifact workspace requires named text deliverables; the cloud ZIP collection is a different route.

ZIP collection supports complete text and binary files, but that does not guarantee the selected employee has tools to create every format. Check the tools available in your installation before asking for a formatted presentation or document. Files outside `out/` are not part of an artifact ZIP.

## Inspect what was captured

After the task completes, look in **Deliverables** or choose **Download artifacts ZIP** in **Run progress**.

For a named deliverable, **Captured** means the server retained a complete file that passed presence and size checks. JSON files also pass a syntax check. These checks do not establish factual accuracy, correct calculations, or suitable writing.

Read the file itself. Check claims against the supplied sources and verify any totals. The file card can show its size, content hash, version, source run, and the employee-profile or skill versions used to produce it. These identify the captured result; they are not a quality score.

If the task is running, **Awaiting captured file** means the output is not available yet. **Not captured** after completion means there is no retained file at that requested path. A filename mentioned in a response is not a substitute for a downloadable result. Read the error, correct the path or reduce the requested output, and submit a new request rather than relying on partial content.

## Review a named deliverable

1. Download and read the captured file.
2. Under **Review decision**, choose **Approve** or **Request revision**. Use **Pending review** if you have not decided.
3. For a revision, add a specific note, up to 500 characters. Say what to change and what should stay.
4. Choose **Save review** and check the **Current saved review** message.

Saving a review records your decision. It does not start another run. Approving a file also does not send it to someone, publish it, or authorize an external action.

To carry out saved feedback, choose **Create revision approval**, then open **Approvals** and inspect that request before approving the work. The revision request refers to the selected artifact version and saved review. If another tab changed the review, inspect the current server result before saving or requesting a revision again.

Where available, **Version history** lets you download previous captured versions from the same logical task. Unrelated tasks with the same filename do not become one shared document history. The ZIP bundle is a download of the run's outputs, not the named-deliverable review workflow.

## Keep downloads private

Named-deliverable downloads require authorized access to the run. Artifact ZIP downloads use a signed link that expires after seven days. **Anyone with the complete ZIP link can download the archive**, so treat it like the files themselves and share it only with intended recipients.

Expiry stops use of that signed link; it is not a promise that stored files or previously downloaded copies have been deleted. Download work you need to keep while the link is available, and follow your installation's retention policy.

For code changes, use [Pull request review](/docs/review/). For context you want to reuse, see [Context and memory](/docs/context-and-memory/).
