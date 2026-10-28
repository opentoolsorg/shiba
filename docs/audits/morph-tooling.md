# Morph coding skills

The workspace includes the five coding skills published in
`@morphllm/morph-setup@1.0.72`: `explore`, `code-research`, `feature-research`,
`fast-apply`, and `morph-cli`. Their upstream files are unchanged under
`.agents/skills/`. The package archive was checked against npm's SHA-512
integrity metadata; `.agents/skills/morph-skills-source.json` records the source,
version, declared MIT license, archive integrity and each file's SHA-256.

Downloaded skills are intentionally ignored by this repository. Restore them
in a fresh checkout with `node scripts/setup-morph-skills.mjs`; the saved cloud
install script runs it too. The command pins the archive integrity, checks all
destinations before copying, and refuses to overwrite locally modified skills
or follow destination symlinks. It does not run the upstream account/model
installer. Repeated installation preserves the same skill contents.

Use exploration and feature research to map relevant code before a change,
code research for external implementations, and Fast Apply for larger edits.
Follow each skill's usage criteria and verify the resulting diff and appropriate
repository checks. Existing task approvals, credential isolation and repository
scope rules still apply.

## Tool connection

Morph's published documentation prefers the `morph` CLI plus these skills. The
CLI installer is hosted on the currently blocked `www.morphllm.com` domain.
The official MCP fallback is configured for Codex in `.codex/config.toml`, pinned
to `@morphllm/morphmcp@0.8.219`, with the current project as its allowed directory.
It receives `MORPH_API_KEY` from the environment; no key is stored in this repo
or passed on a command line. The MCP integration exposes equivalent search/edit
tools; it does not install or impersonate the `morph` executable.

The pinned MCP package was installed separately under
`/workspace/.tools/morph-mcp` without changing application dependencies or
lockfiles. Its actual stdio MCP initialization and tool-list handshake passed.
With no Morph key configured, the upstream server correctly exposes **zero
tools**. No WarpGrep search, Fast Apply edit, live model call, speed or quality
improvement is claimed from that handshake.

The current cloud host does not automatically load the project MCP definition:
plain `codex mcp get morph` reports no registered server. The definition is
prepared for a host that loads project configuration; it is not represented as
an active tool connection in this chat. The same definition can be passed to
Codex explicitly for configuration validation without changing global settings.

After a key is configured securely and the host loads the project MCP config,
the upstream MCP tools are `codebase_search`, `github_codebase_search` and
`edit_file`. The CLI skills use `morph search` and `morph apply` when the preferred
CLI becomes available. Do not substitute a key on the command line or copy a key
into the Worker/container configuration.

## Environment and reference status

The students page could not be read because the environment proxy returned
CONNECT 403. npm's published Morph documentation and bundled skills were
accessible and used as the source. No student-program eligibility, credits or
pricing was verified.

The saved environment draft adds `www.morphllm.com`, `morphllm.com`,
`api.morphllm.com` and `docs.morphllm.com`, preserving previous domains. It also
declares a user-provided `MORPH_API_KEY` requirement for `api.morphllm.com`.
Review/save the environment settings and publish to activate that configuration;
saving the draft does not apply it to this running instance.
