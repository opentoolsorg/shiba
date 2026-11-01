---
title: Task settings reference
description: Technical details for reasoning effort, repository setup, and per-task environment variables.
---

Use this reference when a task needs more than the default settings. For the everyday flow, see [Threads and results](/docs/dashboard/).

## Reasoning effort

The **Effort** chip next to the model picker sets how hard the model thinks on this run. It lists only the levels the selected harness can pass to its CLI:

| Harness | Levels | Passed as |
| --- | --- | --- |
| Claude Code (API key, subscription, login) | low, medium, high, xhigh, max | `claude --effort` |
| Codex (API key) | minimal, low, medium, high, xhigh | `codex -c model_reasoning_effort=…` |
| OpenCode | low, medium, high | `opencode run --variant` |

Other harnesses take no effort. A run that asks for a level its harness can't honor is refused before an approval card exists. The effort is part of the frozen route, so the approval card shows it (`codex · openai/gpt-5 · effort high · via …`), the approval hash covers it, and steering, forks and API retries keep it.

## Repo setup

To have a run prepare the repository before the agent starts, commit a `.shiba/setup.json` and tick **Run repo setup** in the composer's thread configuration menu:

```json
{
  "format_version": 1,
  "scripts": { "initialize": "mkdir -p .cache" },
  "timeouts": { "initialize": 900 }
}
```

- **Opt-in:** the setup script runs only when that box is ticked for the run. The tick is part of what you approve, and the approval card says `Setup: runs .shiba/setup.json initialize`. Steering, forks, API retries and CI follow-ups keep it.
- **Who can opt in:** only the box in the composer, or the authenticated `/api/runs` API. The chat agent's own tool call can't turn setup on.
- **Execution:** the script runs with `sh -c` in the cloned repository and gets the run's environment variables. It's the only repo-authored shell the runtime itself executes; every other command still has to match the exec allowlist. Exec receipts record the step as `.shiba/setup.json#initialize`, not the script text.
- **Network:** setup does not widen the selected harness's egress allowlist. For most harnesses only provider and GitHub hosts are reachable; npm/PyPI downloads are blocked. Use offline setup or dependencies already available in the image. ACP may additionally admit its installer hosts.
- **Timeout:** `timeouts.initialize` defaults to 600 seconds, with a maximum of 900 to keep the run within its deadline. Unknown keys in the file are refused. `scripts.refresh`, `timeouts.refresh` and `entries` are accepted but not run yet.
- **Baseline:** once the script succeeds, its effects are set aside in a local-only git commit (hooks off, never pushed). Installs, rewritten lockfiles and generated files never appear in the change or the pull request.
- **Overlap:** if the agent then changes a file the setup script also changed, the run fails rather than publish setup's edits as the agent's. Keep the script from editing tracked files.
- **Failure:** a missing or invalid file, or a non-zero exit, fails the run before the agent starts. The error shows the script's output tail, redacted like everything else.
- **Not supported:** runs on the local runtime don't take repo setup yet. Subagents and Captain crew runs don't run setup. A background process the script leaves running can still write into the repository.

## Environment variables

**+ → Environment variables** attaches name/value pairs to one run, for things like a test database URL. Values are encrypted for storage. Output redaction has the limits described below:

**Sealing and approval**
- The dashboard sends the values once to `POST /api/runs/env-seal`. That endpoint encrypts them under `MODEL_CREDENTIAL_KEY` and binds the result to your orchestrator and to a keyed digest of the exact values. The digest is an HMAC, so a stored record can't be used to check a guessed value.
- Approval cards and the run API show only the names. The approval hash covers the names and the digest.
- API responses and the event log never include the encrypted blob.

**During the run**
- The run's agent decrypts the values inside the Worker right before the sandbox starts.
- It passes them to the harness process and to the test command. Harness variables win on any shared name.
- Any value of 8 or more characters is replaced with `[redacted:NAME]` in everything the run sends back: progress, summary, stderr, the test-output tail, and the pull request body. This also catches the JSON-escaped form that appears inside agent event lines. The redaction runs before output is truncated, so a cut can't leave part of a value behind.
- If the change adds a value (on an added diff line, or inside a changed binary file), the run fails and the change is dropped, never returned or published. A value the repository already contained, such as a local development URL in an untouched config line, doesn't count.

**After the run**
- Once you decide the approval, the run holds its own copy of the encrypted blob. When the run finishes, that copy is discarded. Chat message metadata can still retain the ciphertext until you rotate `MODEL_CREDENTIAL_KEY` or clear history.
- Forking a finished run that had environment variables, or retrying it through the API, is refused. Start a new run and enter the variables again.
- CI or review events cannot create a coding follow-up for a run whose environment was discarded; they return `environment_discarded` instead. Start a new run and supply the variables again.

**Refused names:** names that steer the harness, egress, TLS trust, the dynamic loader or a toolchain's registry are refused. That covers `PATH`, `HOME`, `TMPDIR`, `*_PROXY`, `NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`, `NODE_TLS_REJECT_UNAUTHORIZED`, `BASH_ENV`, `LD_*`, `PYTHON*`, `NPM_CONFIG_*`, `PIP_*`, `XDG_*`, `GIT_*`, `GITHUB_*` and `SHIBA_*`, plus provider-key prefixes such as `OPENAI_*` and `ANTHROPIC_*`. Ordinary app variables such as `NODE_ENV` or `DATABASE_URL` are fine.

**Limits:** 32 variables, 128-character names, 8 KiB per value and 32 KiB in total.

**Not supported:** runs on the local runtime don't take environment variables yet (this includes deployments whose default `RUNTIME` is `local`). A deployment without `MODEL_CREDENTIAL_KEY` refuses them.

**Known limits:**
- The chat transcript keeps the encrypted blob the composer sent. Rotating `MODEL_CREDENTIAL_KEY` makes every old blob undecryptable.
- Values shorter than 8 characters aren't redacted from output.


Return to [Threads and results](/docs/dashboard/).
