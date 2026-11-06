import { useEffect, useEffectEvent, useRef, useState, type JSX } from "react";
import { APPROVAL_TTL_MS, personalExecutionSnapshotSchema, type PendingApproval } from "@shiba/shared";
import { teamWorkspaceHeaders, TeamWorkspaceRequestError } from "../team-workspaces-client";

export interface RoomApprovalReviewProps {
  workspaceId: string;
  workspaceName?: string;
  roomId: string;
  handoffId: string;
  actorId: string | null;
  onDecided?: (result: "approved" | "rejected") => void;
}
interface RoomApprovalCard {
  approval: Omit<PendingApproval, "envSealed">;
  inputHash: string;
  requesterUserId: string;
  handoffId: string;
}
const BUTTON =
  "min-h-11 border border-[var(--line)] bg-[var(--card)] px-4 text-xs text-[var(--ink)] hover:bg-[var(--panel-2)] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)]";
function approvalExpiry(approval: Omit<PendingApproval, "envSealed">): number {
  return Math.min(approval.createdAt + APPROVAL_TTL_MS, approval.personalExecution?.expiresAt ?? Infinity);
}

/** Room membership permits viewing status, never deciding another person's approval. */
export function RoomApprovalReview(props: RoomApprovalReviewProps): JSX.Element {
  const scope = `${props.actorId ?? ""}\0${props.workspaceId}\0${props.roomId}\0${props.handoffId}`;
  const current = useRef(scope);
  current.current = scope;
  return <ScopedRoomApproval key={scope} {...props} isCurrent={() => current.current === scope} />;
}

function ScopedRoomApproval({
  workspaceId,
  workspaceName,
  roomId,
  handoffId,
  actorId,
  onDecided,
  isCurrent,
}: RoomApprovalReviewProps & { isCurrent: () => boolean }): JSX.Element {
  const [card, setCard] = useState<RoomApprovalCard | null>(null);
  const [loading, setLoading] = useState(Boolean(actorId && workspaceId));
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<"approved" | "rejected" | null>(null);
  const alive = useRef(true);
  const controller = useRef(new AbortController());
  const epoch = useRef(0);
  const pending = useRef(false);
  const cardRef = useRef<RoomApprovalCard | null>(null);
  const active = () => alive.current && isCurrent() && !controller.current.signal.aborted;
  const path = `/api/collaboration/rooms/${encodeURIComponent(roomId)}/handoffs/${encodeURIComponent(handoffId)}/approval`;
  const clear = () => {
    cardRef.current = null;
    setCard(null);
    setReviewed(false);
  };
  const request = async <T,>(method: "GET" | "POST", body?: unknown): Promise<T> => {
    if (!workspaceId || !actorId || !active())
      throw new Error("Select a workspace and sign in before reviewing this approval.");
    const response = await fetch(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.current.signal,
      headers: {
        ...teamWorkspaceHeaders(workspaceId),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const payload = (await response.json().catch(() => ({}))) as T & { error?: unknown };
    if (!active()) throw new DOMException("Workspace changed.", "AbortError");
    if (!response.ok)
      throw new TeamWorkspaceRequestError(
        typeof payload.error === "string"
          ? payload.error
          : `Approval unavailable (${response.status}).`,
        response.status,
      );
    return payload;
  };
  const load = async () => {
    if (!actorId || !workspaceId || !active() || pending.current || outcome) return;
    const generation = ++epoch.current;
    setLoading(true);
    try {
      const next = await request<RoomApprovalCard>("GET");
      if (!active() || generation !== epoch.current) return;
      if (
        next.approval?.status !== "pending" ||
        typeof next.approval.approvalId !== "string" ||
        typeof next.approval.task !== "string" ||
        next.requesterUserId !== actorId.trim().toLowerCase() ||
        next.handoffId !== handoffId ||
        next.approval.collaborationHandoffId !== handoffId ||
        !/^[a-f0-9]{64}$/.test(next.inputHash) ||
        "envSealed" in next.approval ||
        (next.approval.kind && next.approval.kind !== "run") ||
        !Number.isFinite(next.approval.createdAt) ||
        next.approval.createdAt + APPROVAL_TTL_MS <= Date.now()
      )
        throw new Error(
          "This approval cannot be verified for your current account. Refresh the room status.",
        );
      if (next.approval.personalExecution !== undefined) {
        const parsed = personalExecutionSnapshotSchema.safeParse(next.approval.personalExecution);
        const personal = parsed.success ? parsed.data : null;
        if (!personal || personal.actorId !== next.requesterUserId || personal.workspaceId !== workspaceId ||
            personal.repoUrl !== next.approval.repoUrl || personal.machineId !== next.approval.targetMachineId ||
            next.approval.runtime !== "local" || next.approval.publishPullRequest !== false || next.approval.runSetup === true ||
            personal.expiresAt <= Date.now() || (next.approval.route && (next.approval.route.harness !== personal.harness || next.approval.route.modelId !== personal.codingModel))) {
          throw new Error("The frozen personal account route cannot be verified. Request a new reviewed grant and task.");
        }
      }
      if (
        cardRef.current?.inputHash !== next.inputHash ||
        cardRef.current.approval.approvalId !== next.approval.approvalId ||
        JSON.stringify(cardRef.current.approval.personalExecution) !== JSON.stringify(next.approval.personalExecution)
      )
        setReviewed(false);
      cardRef.current = next;
      setCard(next);
      setError(null);
    } catch (cause) {
      if (active() && generation === epoch.current) {
        clear();
        setError(cause instanceof Error ? cause.message : "Approval unavailable.");
      }
    } finally {
      if (active() && generation === epoch.current) setLoading(false);
    }
  };
  const refresh = useEffectEvent(() => {
    void load();
  });
  useEffect(() => {
    alive.current = true;
    const abort = new AbortController();
    controller.current = abort;
    refresh();
    const timer = setInterval(refresh, 10_000);
    const focus = () => refresh();
    window.addEventListener("focus", focus);
    return () => {
      alive.current = false;
      epoch.current++;
      abort.abort();
      clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, []);
  const expire = useEffectEvent(() => {
    if (active()) {
      clear();
      setError("This approval expired. Queue a new request for a fresh human decision.");
    }
  });
  useEffect(() => {
    if (!card) return;
    const expiresIn = approvalExpiry(card.approval) - Date.now();
    const timer = setTimeout(expire, Math.max(0, expiresIn));
    return () => clearTimeout(timer);
  }, [card]);

  const decide = (approved: boolean) => {
    if (
      !card ||
      !reviewed ||
      pending.current ||
      !active() ||
      card.requesterUserId !== actorId?.trim().toLowerCase()
    )
      return;
    if (approvalExpiry(card.approval) <= Date.now()) {
      clear();
      setError("This approval expired. Queue a new request.");
      return;
    }
    const snapshot = card;
    pending.current = true;
    setBusy(true);
    setError(null);
    epoch.current++;
    void (async () => {
      try {
        const next = await request<{
          result: "approved" | "rejected";
          approvalId: string;
          inputHash: string;
        }>("POST", { expectedInputHash: snapshot.inputHash, reviewed: true, approved });
        if (!active()) return;
        if (
          next.approvalId !== snapshot.approval.approvalId ||
          next.inputHash !== snapshot.inputHash ||
          next.result !== (approved ? "approved" : "rejected")
        )
          throw new Error(
            "The decision response could not be verified. Refresh room status before deciding again.",
          );
        clear();
        setOutcome(next.result);
        onDecided?.(next.result);
      } catch (cause) {
        if (active()) {
          clear();
          setError(
            cause instanceof TeamWorkspaceRequestError
              ? cause.message
              : "The decision outcome is unconfirmed. Refresh room status before retrying; no decision will be sent automatically.",
          );
        }
      } finally {
        if (active()) {
          pending.current = false;
          setBusy(false);
          setLoading(false);
        }
      }
    })();
  };

  const approval = card?.approval;
  const target = approval?.executionTarget;
  const personal = approval?.personalExecution;
  return (
    <section
      aria-label="Review shared run approval"
      className="min-w-0 border border-[var(--line)] bg-[var(--card)] p-4 text-[var(--ink)]"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-[var(--ink-2)]">
            Human approval · exact frozen input
          </p>
          <h3 className="mt-1 text-lg">Review this shared run</h3>
        </div>
        <span className="font-mono text-xs text-[var(--ink-2)]">
          {workspaceName ?? workspaceId}
        </span>
      </div>
      <p className="mt-2 text-xs text-[var(--ink-2)]">
        Only the authenticated requester can decide this approval. Team membership and employee
        roles do not confer approval authority.
      </p>
      {error && (
        <p role="alert" className="mt-3 break-words text-sm text-[var(--danger)]">
          {error}
        </p>
      )}
      {outcome && (
        <p role="status" className="mt-3 text-sm">
          {outcome === "approved"
            ? "Approval recorded. Follow the room's run status for the execution outcome."
            : "Rejection recorded. This approval will not start the run."}
        </p>
      )}
      {!actorId || !workspaceId ? (
        <p className="mt-3 text-sm">Sign in and select the run's team workspace to review it.</p>
      ) : !approval ? (
        <div className="mt-3">
          {loading && (
            <p role="status" className="text-sm">
              Checking current requester, membership and source scope…
            </p>
          )}
          {!loading && !outcome && (
            <button
              type="button"
              className={BUTTON}
              onClick={() => {
                void load();
              }}
              disabled={busy}
            >
              Refresh approval
            </button>
          )}
        </div>
      ) : (
        <>
          <dl className="mt-4 grid min-w-0 gap-3 text-xs sm:grid-cols-2">
            <div>
              <dt className="font-semibold">Workspace</dt>
              <dd className="mt-1 break-all">
                {workspaceName ? `${workspaceName} · ` : ""}
                {workspaceId}
              </dd>
            </div>
            <div>
              <dt className="font-semibold">Requester</dt>
              <dd className="mt-1 break-all">{card.requesterUserId}</dd>
            </div>
            <div>
              <dt className="font-semibold">Execution target</dt>
              <dd className="mt-1 break-all">
                {target?.kind === "artifact-workspace"
                  ? `Artifact workspace${target.workspaceName ? ` · ${target.workspaceName}` : ""}`
                  : target?.kind === "repository"
                    ? `${target.repoUrl} · ${target.baseBranch}`
                    : target?.kind === "connected-app"
                      ? `${target.connectionId} · ${target.action}`
                      : `${approval.repoUrl} · ${approval.baseBranch ?? "Branch not specified"}`}
              </dd>
            </div>
            <div>
              <dt className="font-semibold">Runtime</dt>
              <dd className="mt-1 break-all">
                {approval.runtime ?? "sandbox (legacy default)"}
                {approval.targetMachineId ? ` · machine ${approval.targetMachineId}` : ""}
                {!personal && approval.sandboxProvider ? ` · ${approval.sandboxProvider}` : ""}
              </dd>
            </div>
            <div>
              <dt className="font-semibold">Provider and coding tool</dt>
              <dd className="mt-1 break-all">
                {personal ? `${personal.harness} · ${personal.codingModel} · your native subscription account`
                  : <>{approval.route?.harness ?? approval.harness ?? "Not specified in frozen record"} ·{" "}
                    {approval.route?.modelId ?? "Model not specified"} · connection{" "}{approval.route?.connectionId ?? "deployment default"}
                    {approval.authAccount ? ` · account ${approval.authAccount}` : ""}</>}
              </dd>
            </div>
            <div>
              <dt className="font-semibold">Expires</dt>
              <dd className="mt-1">
                {new Date(approvalExpiry(approval)).toLocaleString()}
              </dd>
            </div>
            {personal && <>
              <div><dt className="font-semibold">Frozen personal account</dt><dd className="mt-1 break-all">Fingerprint {personal.accountFingerprint.slice(0, 12)} · billing {personal.billingMode}. Locally observed login; live entitlement is not verified.</dd></div>
              <div><dt className="font-semibold">Frozen personal machine</dt><dd className="mt-1 break-all">{personal.machineId} · revision {personal.machineRevision}</dd></div>
              <div><dt className="font-semibold">Frozen personal grant</dt><dd className="mt-1 break-all">{personal.grantId} · v{personal.grantVersion} · expires {new Date(personal.expiresAt).toLocaleString()}</dd></div>
              <div><dt className="font-semibold">Personal execution scope</dt><dd className="mt-1 break-words">Public repository {personal.repoUrl} · exact model {personal.codingModel}. Local repository task only. No deployment account, cloud model, specialist, publication or app fallback.</dd></div>
              <div className="sm:col-span-2"><dt className="font-semibold">Local host access</dt><dd className="mt-1 break-words">The CLI runs as your operating system user and can access host files. A fresh configuration home is not an OS sandbox. This deployment still hosts Worker and storage costs.</dd></div>
            </>}
            <div className="sm:col-span-2">
              <dt className="font-semibold">Exact task and selected context</dt>
              <dd className="mt-2 whitespace-pre-wrap break-words leading-relaxed">
                {approval.task}
              </dd>
            </div>
            <div>
              <dt className="font-semibold">Reviewed skill pins</dt>
              <dd className="mt-1">
                {approval.skillPins?.length ? (
                  <ul>
                    {approval.skillPins.map((pin) => (
                      <li key={pin.skillId} className="break-all">
                        {pin.name} · v{pin.version} · {pin.skillId}
                      </li>
                    ))}
                  </ul>
                ) : (
                  "No reviewed skills pinned."
                )}
              </dd>
            </div>
            <div>
              <dt className="font-semibold">External publication</dt>
              <dd className="mt-1">
                {approval.publishPullRequest
                  ? "Pull request requested. Publishing its final frozen changes requires a separate human approval."
                  : "No pull request publication requested."}
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="font-semibold">Spend and usage</dt>
              <dd className="mt-1">
                Starting this run may incur provider or runtime usage on the configured account. No
                purchase, transfer, or amount-based spend approval is included.
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="font-semibold">Frozen input hash</dt>
              <dd className="mt-1 break-all font-mono text-[10px]">{card.inputHash}</dd>
            </div>
          </dl>
          <details className="mt-4 border-y border-[var(--line)] py-3">
            <summary className="min-h-11 cursor-pointer py-3 text-xs">
              Complete frozen approval scope
            </summary>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-[10px] text-[var(--ink-2)]">
              {JSON.stringify(approval, null, 2)}
            </pre>
          </details>
          <label className="mt-4 flex min-h-11 cursor-pointer items-start gap-2 text-xs">
            <input
              type="checkbox"
              className="mt-0.5 size-4 shrink-0"
              checked={reviewed}
              disabled={busy}
              onChange={(event) => setReviewed(event.target.checked)}
            />
            <span>I reviewed this exact task, target, provider, runtime and selected context.{personal ? " I also reviewed my frozen native account, grant, machine, model, billing mode, expiry and local host access." : ""}</span>
          </label>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className={BUTTON}
              disabled={!reviewed || busy}
              onClick={() => decide(true)}
            >
              {busy ? "Recording decision…" : "Approve run"}
            </button>
            <button
              type="button"
              className={BUTTON}
              disabled={!reviewed || busy}
              onClick={() => decide(false)}
            >
              Reject run
            </button>
          </div>
        </>
      )}
    </section>
  );
}
