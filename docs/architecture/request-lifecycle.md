# Request lifecycle


```
1  ingress    dashboard / Slack / cron / webhook → auth per surface
2  intent     orchestrator plans; prose → structured delegate_coding_task
3  gate       approval card with the exact frozen arguments; human approves
              (automations always wait for human approval)
4  dispatch   approved input frozen; route revalidated at dispatch
5  sandbox    ephemeral container: clone (scoped) → run the harness CLI
6  egress     AI Gateway swaps the dummy key for the real provider key (or injects org-configured provider API key)
7  collect    diff, exit code, structured result envelope (error ≠ completed)
8  propose    stage immutable publication files in private R2
9  gate       separate human approval permits the branch and PR action
10 cleanup    container destroyed; short sleep tail; result + receipts recorded
```

**Per-org sandbox runners and model keys**: Orgs can bring their own sandbox runners (ComputeSDK remote runner URL and token encrypted at rest via AES-GCM in D1) and paste raw provider API keys (`anthropic`, `openai`, `google`, `xai`, stored encrypted in D1 write-only). At edge egress, `orgId` resolves decrypted keys and injects native auth headers (`x-api-key`, `Authorization: Bearer`, `x-goog-api-key`) through Cloudflare AI Gateway, falling back to deployment BYOK aliases when unconfigured. Runner URLs are HTTPS-only and SSRF-validated against private, loopback, link-local, and CGNAT networks.

Steps **3** and **6** are the load-bearing ones. Everything else is
replaceable — which is why resumable runs (`PLAN.md` §4) and the parity waves
can be built without touching them.

**Local lane** (`runtime:"local"`, dark unless `SHIBA_LOCAL_RUNTIME=1`): the
same intake → gate → approve → dispatch path, but step 5's container is
replaced by the operator's own machine. `LocalRuntimeAdapter` posts a
schema-checked envelope (`localRunEnvelopeSchema`) to the `LocalDispatch` DO;
the operator-run daemon (`scripts/shiba-local-daemon.mjs`) polls
`POST /api/local/claim` + `POST /api/local/result` behind a `LOCAL_ADAPTER_TOKEN`
bearer, executes under the same exec/setup allowlists the envelope carries,
returns receipts + diff, and the Worker runs the identical `harness.verify`
verdict and PR publish. Chat intake is provably impossible: `queueSlackRun`
refuses `runtime:"local"` unless the request carries the `X-Shiba-Intake:
dashboard` voucher that only `handleRuns` stamps (inbound copies are deleted
first). Capability opt-in: `opencode`, `claude-code`, `codex` declare
`supportedRuntimes:["sandbox","local"]`; every other harness refuses.
Provider credentials stay local — the dummy key is dropped from the envelope
and config bodies reference `${OPENCODE_API_KEY}`-style placeholders resolved
on the operator side.

---
