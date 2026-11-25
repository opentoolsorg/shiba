# Shiba Desktop plan

Status: historical implementation planning document. This version removes
external reference-product framing and states the Shiba-owned design boundary.

Shiba Desktop is an operator companion for the same approval-first workspace.
It must not become a second control plane, a credential broker, or a way to
bypass the Worker approval gate.

## Product role

The desktop app provides:

- the Shiba dashboard in a native window;
- pairing for a trusted operator machine;
- local machine presence and lifecycle controls;
- access to approved local work through the existing `LocalDispatch` boundary;
- operator-visible evidence for local runs.

The desktop app does not provide:

- direct repository or provider authority;
- a separate approval path;
- unattended local execution without an approved envelope;
- credential storage for sandbox lanes;
- a second orchestration engine.

## Architecture

```text
Shiba Desktop shell
  → loads the authenticated dashboard
  → pairs the operator machine with the Worker
  → starts or supervises the local daemon
  → daemon polls LocalDispatch
  → approved envelope runs locally
  → result returns in the shared run/evidence shape
```

The Worker remains the control plane. The daemon is an execution adapter. The
desktop shell is presentation plus operator-machine lifecycle support.

## Security boundaries

- Pairing proves machine ownership for the paired user or workspace lane. It is
  not blanket execution authority.
- Every local job still requires approval before dispatch.
- Local jobs use the frozen envelope in `LocalDispatch`.
- The daemon must reject work whose approval, expiry, lane, or input hash does
  not match the claim.
- Attachments, per-run environment, repository setup, and artifact support stay
  disabled until their local-lane contracts are explicit.
- Local browser sign-in state belongs to the operator machine. Shiba must not
  copy it into cloud storage or containers.

## Implementation surfaces

| Surface | Ownership |
|---|---|
| Desktop shell/window | `apps/desktop` |
| Dashboard UI | `apps/frontend` |
| Worker pairing and dispatch APIs | `apps/backend` |
| Local job execution | local daemon scripts/packages |
| Shared wire contracts | `packages/shared` |

Keep the shell thin. Product behavior belongs in the dashboard or the Worker so
browser and desktop users see the same approval, evidence, and publication
states.

## Readiness checklist

Before calling desktop launched:

1. Pair, rotate, revoke, and re-pair a machine.
2. Prove an unapproved local job cannot start.
3. Prove a malformed or expired dispatch claim fails closed.
4. Run one approved local artifact job and verify private evidence export.
5. Prove cancellation reaches the daemon.
6. Prove revocation stops new claims and is visible in the dashboard.
7. Sign/notarize the installer for the supported platform.
8. Document what local runtimes, attachments, environment variables, browser
   state, and repository setup do not yet support.
