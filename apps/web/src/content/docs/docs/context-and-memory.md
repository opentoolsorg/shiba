---
title: Context and memory
description: Save private reference material, reuse project context, and understand what changes after approval.
---

An AI employee works best with a short, current brief and the right source material. Keep instructions about how to work in the [employee profile](/docs/employees/) or a [skill](/docs/skills/). Use memory sources for reference facts, notes, and documents.

## Save useful reference material

Open **Memory** and its **Sources** view. The source library is labeled **OWNER PRIVATE**: it belongs to your signed-in account. Selecting a team workspace does not make this library team-readable.

Choose one of two ways to add a source:

- **Add to memory:** give the source a title, choose a type, and paste the relevant text. The title can contain up to 200 characters and the text up to 40,000 characters.
- **Upload source file:** upload a nonempty UTF-8 TXT or Markdown file, up to 40,000 bytes. PDF, Office documents, archives, HTML, and SVG are not supported by this uploader. A file becomes ready only after validation and private storage succeed.

An optional HTTPS **Reference URL** records where the material came from. Shiba does not fetch that page. Include the source text you need rather than saving only a link.

Prefer focused, dated material: a product fact sheet, a release checklist, or the decisions from a meeting. Avoid secrets and unnecessary personal information. Private storage does not mean context stays on your computer: when used for a task, relevant text can be sent to its configured model or execution service.

## Check what can be recalled

Use **Recall from memory** to search active sources. Retrieval uses local keyword ranking, so try the specific product, customer, or topic words in the material. It is not a web search or a promise that every relevant fact will be found.

Inspect the returned excerpts, source titles, and available version, hash, line, or section citations. An excerpt may be shortened. A matching source is reference evidence, not permission to follow instructions embedded in it, connect an account, or take an action.

Saving a source does not guarantee that its entire contents will be inserted into every future conversation. Select the context needed for the task and check what the approval includes.

## Reuse a project brief

A memory project groups up to eight active sources around a purpose. For example, a “November launch” project could include the product fact sheet, audience notes, and launch checklist.

1. Create a project in the source view, with a name, purpose, and selected sources.
2. Optionally set a default employee and harness.
3. In the task composer, choose the project under **Project context**.
4. Choose **Apply project defaults** if you want those defaults to change the task settings, then check the resulting selection.
5. Review the task approval before execution.

The project snapshot freezes when the approval is created. It contains bounded excerpts, currently up to 360 characters per selected source, rather than a guaranteed full copy of every document. Put essential requirements in the task brief and check any truncation notice. Project defaults are conveniences, not new tool access or execution permission.

Updating a source or project changes future snapshots. It does not rewrite an already approved task. If a pending request has the wrong context, reject it and create a new request with the corrected brief.

## Correct, disable, or forget a source

Use **Edit** to correct source text. Versioned sources retain the version identity used for earlier results, and saving a correction creates a new version. If Shiba reports a conflict with an edit elsewhere, review the current source before saving again.

Retention defaults to **365 days**. You can choose 30 days, 90 days, two years, or **Keep until deleted**.

| Control | What it changes |
| --- | --- |
| **Disable** | Excludes the source from future retrieval; **Enable** can make it active again if it has not expired. |
| Retention expiry | Excludes the text from future recall. Original uploaded files remain stored until deletion. |
| **Delete** | Forgets the source for future retrieval and requests deletion of its stored file versions. Existing approved snapshots remain unchanged. |
| **Retry file cleanup** | Retries pending removal when storage cleanup could not finish. The affected versions are already excluded from retrieval. |

A deletion does not remove copies already downloaded or context already copied into approved work. Follow your installation's broader retention policy if you need those records removed too.

If an upload is marked unresolved, it has no committed new version. Refresh to check its state. Ask the operator to reconcile an interrupted upload rather than treating it as ready or assuming it was deleted.

## Share deliberately

Owner-private sources, shared room messages, employee instructions, and workspace skills have different audiences. When you intentionally use private context in shared work, review the resulting brief and output for information that audience should not receive. Room membership does not grant access to the original private library.

Next: [Work with your team](/docs/team-workspaces/), [Files and revisions](/docs/artifacts/), or [Permissions and roles](/docs/permissions/).
