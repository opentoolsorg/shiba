# Harnesses

Harnesses are pluggable execution CLIs/transports inside runtime lanes. They are
not the Employee Orchestrator and not the center of the product. A run selects
exactly one harness after approval; the control plane still owns identity,
workspace scope, approval, lineage, evidence, cancellation, and publication.

One image ships nine agent CLIs (`opencode`, `claude`, `codex`, `grok`,
`devin`, `cursor-agent`, `gemini`, `agy`, `procoder`) plus two ACP adapter
packages (`claude-agent-acp`, `codex-acp`). A run selects exactly one
harness lane.

API-key lanes (AI Gateway BYOK):

| Harness | Binary | Default model | Credential |
|---|---|---|---|
| `opencode` | `opencode` | `google/gemini-3.5-flash-lite` | AI Gateway BYOK |
| `claude-code` | `claude` | `anthropic/claude-sonnet-4-6` | AI Gateway BYOK |
| `codex` | `codex` | `openai/gpt-5.3-codex` | AI Gateway BYOK |
| `devin` | `devin` | `devin/swe-2-medium` | `DEVIN_API_KEY` secret (api.devin.ai + server.codeium.com egress) |
| `grok` | `grok` | `xai/grok-4.6` (medium reasoning) | AI Gateway BYOK |
| `cursor` | `cursor-agent` | `cursor/claude-4-5-sonnet` | AI Gateway BYOK — registered but not sandbox-runnable (no `supportedRuntimes` entry) |
| `antigravity` | `agy` | `google/gemini-3.5-flash` | registered, likewise not sandbox-runnable |

Subscription lanes (opt-in `SHIBA_*_SUBSCRIPTION=1`, dedicated egress
branches that bypass AI Gateway):

| Harness | Binary | Default model | Credential |
|---|---|---|---|
| `claude-subscription` | `claude` | `anthropic-subscription/claude-sonnet-4-6` | `CLAUDE_SUBSCRIPTION_TOKEN[_<ACCOUNT>]` secret |
| `codex-subscription` | `codex` | `openai-subscription/gpt-5.3-codex` | `CODEX_SUBSCRIPTION_AUTH_JSON` secret (auth.json contents) on a dedicated chatgpt.com egress branch; container CODEX_HOME gets a stub auth.json in a per-account shadow home |
| `antigravity-subscription` | `agy` (ACP server, pinned in image) | `google-subscription/gemini-3-pro` | In-container OAuth — no Worker credential. `POST /api/auth/antigravity-subscription/begin` boots an auth sandbox that prints the Google URL; the operator signs in and pastes the dead `127.0.0.1` redirect into `POST /api/antigravity/callback`, which forwards it to the container listener. Tokens live only in the per-account profile under `/root/.shiba/antigravity/` |
| `cursor-subscription` | `cursor-agent` | `cursor-subscription/auto` | `CURSOR_SUBSCRIPTION_TOKEN[_<ACCOUNT>]` on the CLI's two egress hosts |
| `devin-subscription` | `devin` | `devin-subscription/swe-2-medium` | `DEVIN_SUBSCRIPTION_TOKEN[_<ACCOUNT>]` on api.devin.ai + server.codeium.com |

ACP lanes (PLAN-V2-NEXT — every ACP-capable agent the image ships,
driven through the Agent Client Protocol by a shared CJS driver,
`ACP_DRIVER_SOURCE` in `harness/acp.ts`):

| Harness | Spawn | Default model |
|---|---|---|
| `claude-acp` | `claude-agent-acp` | `anthropic/claude-sonnet-4-6` |
| `codex-acp` | `codex-acp` | `openai/gpt-5.3-codex` |
| `gemini-acp` | `gemini --acp` | `google/gemini-3.5-flash` |
| `opencode-acp` | `opencode acp` | `google/gemini-3.5-flash-lite` |
| `devin-acp` | `devin acp` | `devin/swe-2-medium` |

The driver spawns the adapter, speaks JSON-RPC (`session/new`,
`session/prompt`, `session/set_model` with `-32601` tolerance,
auto-answered permission requests with per-call timeouts), and emits the
run lane's normal event stream — credentials ride the provider's existing
BYOK/worker-secret lane, so ACP lanes add no new auth surface.

Defaults live in `harness/index.ts` (`HARNESS_DEFAULT_MODELS`) and are
overridable per deploy (`CODING_MODEL`, `CLAUDE_CODE_MODEL`, `CODEX_MODEL`,
`DEVIN_MODEL`, `GROK_MODEL`, `PI_MODEL`) and per run via the delegate tool's
`codingModel` input. They are defaults, **not
availability guarantees** — model ids retire, and `coding-model.ts` asserts the
configured model is not on the retired deny-list at first request.

Versions are pinned in the Dockerfile and mirrored in `harness/catalog.ts` —
**bump both** (T26). Selection is per run, defaulting to the deploy-time
`AGENT_HARNESS`; an invalid harness throws *before* approval, never as an exec
error inside the container. Grok runs its verified headless print mode
(`--single` + `streaming-json`) pinned to the `api.x.ai` forwarder via
`GROK_MODELS_BASE_URL`. ACP is now a first-class transport: the five
`*-acp` lanes and the cursor lanes share the same embedded driver; bare
`cursor`/`antigravity` remain registered-but-unrunnable (no sandbox
`supportedRuntimes` entry) until their runnability is proven.

**Caveat carried from `docs/plans/plan.md` §2.0:** only OpenCode has completed a live run.
The other lanes are unit-tested against their documented stream formats;
the ACP lanes additionally need the sandbox image rebuilt with their
adapter CLIs before a live run can exercise them.

---
