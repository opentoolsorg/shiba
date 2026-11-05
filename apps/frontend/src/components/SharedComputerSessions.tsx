import type {
  SharedComputerAction,
  SharedComputerSession,
  SharedComputerState,
} from "@shiba/shared";
import { useEffect, useRef, useState } from "react";
import {
  SharedComputerClient,
  SharedComputerRequestError,
  type SharedComputerScope,
} from "../shared-computer-client";

const BUTTON =
  "min-h-11 border border-[var(--line)] bg-[var(--card)] px-3 text-xs text-[var(--ink)] disabled:opacity-50";
const FIELD =
  "mt-1 min-h-11 w-full min-w-0 border border-[var(--input-line)] bg-[var(--paper)] p-2 text-xs text-[var(--ink)]";
type StopRef = Pick<SharedComputerSession, "id" | "roomId" | "version">;
export function SharedComputerSessions(props: SharedComputerScope) {
  return <ComputerScope key={`${props.workspaceId}:${props.roomId}:${props.actorId}`} {...props} />;
}
function ComputerScope(scope: SharedComputerScope) {
  // The exported wrapper remounts this component for every authority scope.
  const [client] = useState(() => new SharedComputerClient(scope));
  const [state, setState] = useState<SharedComputerState | null>(null),
    [selection, setSelection] = useState("");
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [now, setNow] = useState(Date.now());
  const [funder, setFunder] = useState(""),
    [viewers, setViewers] = useState<string[]>([]),
    [controllers, setControllers] = useState<string[]>([]),
    [duration, setDuration] = useState("");
  const [review, setReview] = useState(""),
    [text, setText] = useState(""),
    [image, setImage] = useState<{
      url: string;
      sessionId: string;
      digest: string;
      expiresAt: number;
    } | null>(null);
  const [stops, setStops] = useState<StopRef[]>([]),
    [blocked, setBlocked] = useState<string[]>([]);
  const [stopping, setStopping] = useState<string[]>([]);
  const mounted = useRef(false),
    abort = useRef(new AbortController()),
    operating = useRef(false),
    refreshing = useRef(false),
    latches = useRef(new Set<string>()),
    objectUrl = useRef<string | null>(null);
  const session = state?.sessions.find((s) => s.id === selection),
    current = Boolean(state?.available && session && session.contract.expiresAt > now);
  const lease = Boolean(
    current &&
      session?.state === "running" &&
      session.canControl &&
      session.lease?.ownerId === scope.actorId &&
      session.lease.expiresAt > now &&
      !blocked.includes(session.id),
  );
  const clearImage = () => {
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null;
    setImage(null);
  };
  const adopt = (next: SharedComputerState) => {
    if (!mounted.current) return;
    setState({
      ...next,
      sessions: next.sessions.map((item) =>
        latches.current.has(`stop:${item.id}`)
          ? { ...item, canStart: false, canControl: false, canView: false }
          : item,
      ),
    });
    setReview("");
    setStops(
      next.sessions
        .filter((s) => s.canStop && s.state !== "stopped")
        .map(({ id, roomId, version }) => ({ id, roomId, version })),
    );
    const selected = next.sessions.find((s) => s.id === selection);
    if (
      !selected?.canView ||
      selected.state !== "running" ||
      selected.contract.expiresAt <= Date.now()
    )
      clearImage();
  };
  const deny = (cause: unknown) => {
    if (!mounted.current) return;
    clearImage();
    setReview("");
    if (cause instanceof SharedComputerRequestError && [401, 403, 404].includes(cause.status)) {
      setState(null);
      setSelection("");
      setViewers([]);
      setControllers([]);
      setFunder("");
    }
    setError(
      cause instanceof SharedComputerRequestError
        ? cause.message
        : "The response could not be verified. Refresh current state before another action.",
    );
  };
  const refresh = async () => {
    if (!mounted.current || refreshing.current) return;
    refreshing.current = true;
    try {
      const next = await client.state(abort.current.signal);
      if (mounted.current) {
        adopt(next);
        setError("");
      }
    } catch (cause) {
      deny(cause);
    } finally {
      refreshing.current = false;
    }
  };
  const effect = useRef({ refresh, clearImage });
  effect.current = { refresh, clearImage };
  const shouldPoll = session?.state === "running" && session.contract.expiresAt > now;
  useEffect(() => {
    mounted.current = true;
    abort.current = new AbortController();
    void effect.current.refresh();
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => {
      mounted.current = false;
      abort.current.abort();
      clearInterval(timer);
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = null;
    };
  }, []);
  useEffect(() => {
    if (!shouldPoll) return;
    // Metadata only: no automatic capture, allocation, renewal, input or retry.
    const timer = setInterval(() => {
      if (!operating.current) {
        effect.current.clearImage();
        void effect.current.refresh();
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [shouldPoll]);
  useEffect(() => {
    if (
      image &&
      (image.expiresAt <= now ||
        !current ||
        !session?.canView ||
        image.sessionId !== session.id ||
        image.digest !== session.digest)
    )
      effect.current.clearImage();
  }, [now, current, image, session]);
  const perform = async (key: string, id: string | null, effect: () => Promise<void>) => {
    if (!mounted.current || operating.current || latches.current.has(key)) return;
    operating.current = true;
    latches.current.add(key);
    setBusy(true);
    setError("");
    setNotice("");
    clearImage();
    try {
      await effect();
    } catch (cause) {
      if (mounted.current && id) setBlocked((old) => (old.includes(id) ? old : [...old, id]));
      deny(cause);
    } finally {
      operating.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const update = (next: SharedComputerSession) => {
    if (!mounted.current || latches.current.has(`stop:${next.id}`)) return;
    setState((old) =>
      old ? { ...old, sessions: [next, ...old.sessions.filter((s) => s.id !== next.id)] } : old,
    );
    setReview("");
    if (next.canStop && next.state !== "stopped")
      setStops((old) => [
        { id: next.id, roomId: next.roomId, version: next.version },
        ...old.filter((s) => s.id !== next.id),
      ]);
  };
  const reviewKey = session ? `${session.id}:${session.version}:${session.digest}` : "";
  const prepare = () => {
    const funding = state?.members.find((m) => m.userId === funder && m.canFund),
      selected = viewers.map((id) => state?.members.find((m) => m.userId === id));
    if (
      !state?.available ||
      !funding ||
      !duration ||
      !viewers.includes(scope.actorId) ||
      !controllers.length ||
      selected.some((m) => !m)
    )
      return;
    const requestId = crypto.randomUUID();
    void perform(`prepare:${requestId}`, null, async () => {
      const next = await client.prepare(
        {
          requestId,
          roomId: scope.roomId,
          fundingMember: { userId: funding.userId, version: funding.version },
          viewers: selected.map((m) => ({ userId: m!.userId, version: m!.version })),
          controllers,
          expiresAt: Date.now() + Number(duration),
        },
        abort.current.signal,
      );
      if (mounted.current) {
        update(next);
        setSelection(next.id);
        setNotice(
          "Frozen desktop prepared. Separate operator funding and owner review are required before a container starts.",
        );
      }
    });
  };
  const send = (action: SharedComputerAction) => {
    if (!session || !lease || busy || session.inputCount >= 300) return;
    const key = `input:${session.id}:${session.lease!.version}:${session.nextSequence}`;
    void perform(key, session.id, async () => {
      const next = await client.input(session, action, crypto.randomUUID(), abort.current.signal);
      if (mounted.current) {
        update(next);
        setText("");
        setNotice("Input receipt returned. Capture explicitly to inspect the current display.");
      }
    });
  };
  const stop = async (item: StopRef) => {
    const key = `stop:${item.id}`;
    if (!mounted.current || latches.current.has(key)) return;
    latches.current.add(key);
    setStopping((old) => [...old, item.id]);
    setBlocked((old) => (old.includes(item.id) ? old : [...old, item.id]));
    clearImage();
    try {
      await client.stop(item, abort.current.signal);
      if (mounted.current) {
        setStops((old) => old.filter((s) => s.id !== item.id));
        setNotice("Dedicated desktop destruction acknowledged. No coding CLI was interrupted.");
        await refresh();
      }
    } catch (cause) {
      deny(cause);
    } finally {
      if (mounted.current) setStopping((old) => old.filter((id) => id !== item.id));
    }
  };
  return (
    <section
      className="min-w-0 border border-[var(--line)] bg-[var(--card)] p-3 text-[var(--ink)]"
      aria-label="Offline shared computer"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-base font-semibold">Offline shared computer</h3>
          <p className="mt-1 max-w-3xl text-xs">
            A separate temporary desktop for selected humans. No internet, connected accounts,
            coding agents or active CLI control. Workspace roles do not authorize deployment
            billing.
          </p>
        </div>
        <button
          type="button"
          className={BUTTON}
          disabled={busy}
          onClick={() => {
            clearImage();
            void refresh();
          }}
        >
          Refresh computer state
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-3 break-words text-xs">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mt-3 text-xs">
          {notice}
        </p>
      )}
      {state && !state.available && (
        <p role="status" className="mt-3 text-xs">
          Unavailable: {state.unavailableReason}. A configured, verified dedicated image and runtime
          are required. Nothing starts automatically.
        </p>
      )}
      {state?.available && (
        <details className="mt-3 min-w-0 border border-[var(--line)] p-3">
          <summary className="min-h-11 cursor-pointer text-sm">
            Prepare a separate offline desktop
          </summary>
          <label className="block text-xs">
            Explicit deployment funding operator
            <select
              className={FIELD}
              value={funder}
              disabled={busy}
              onChange={(e) => setFunder(e.target.value)}
            >
              <option value="">Choose a verified operator. None selected.</option>
              {state.members
                .filter((m) => m.canFund)
                .map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.userId} · membership v{m.version}
                  </option>
                ))}
            </select>
          </label>
          <label className="mt-3 block text-xs">
            Fixed desktop expiry
            <select
              className={FIELD}
              value={duration}
              disabled={busy}
              onChange={(e) => setDuration(e.target.value)}
            >
              <option value="">Choose a time limit</option>
              <option value="300000">5 minutes from preparation</option>
              <option value="600000">10 minutes from preparation</option>
            </select>
          </label>
          <fieldset className="mt-3 min-w-0 border border-[var(--line)] p-2">
            <legend className="px-1 text-xs">
              Who can see the entire display? Select up to eight, including yourself.
            </legend>
            {state.members.map((m) => (
              <label key={m.userId} className="flex min-h-11 items-center gap-2 break-all text-xs">
                <input
                  type="checkbox"
                  checked={viewers.includes(m.userId)}
                  disabled={busy || (!viewers.includes(m.userId) && viewers.length >= 8)}
                  onChange={(e) => {
                    setViewers((old) =>
                      e.target.checked ? [...old, m.userId] : old.filter((id) => id !== m.userId),
                    );
                    if (!e.target.checked)
                      setControllers((old) => old.filter((id) => id !== m.userId));
                  }}
                />
                {m.userId}
              </label>
            ))}
          </fieldset>
          <fieldset className="mt-3 min-w-0 border border-[var(--line)] p-2">
            <legend className="px-1 text-xs">
              Named humans allowed to claim exclusive control
            </legend>
            {viewers.map((id) => (
              <label key={id} className="flex min-h-11 items-center gap-2 break-all text-xs">
                <input
                  type="checkbox"
                  checked={controllers.includes(id)}
                  disabled={busy}
                  onChange={(e) =>
                    setControllers((old) =>
                      e.target.checked ? [...old, id] : old.filter((item) => item !== id),
                    )
                  }
                />
                {id}
              </label>
            ))}
          </fieldset>
          <button
            type="button"
            className={`${BUTTON} mt-3`}
            disabled={
              busy ||
              !funder ||
              !duration ||
              !viewers.includes(scope.actorId) ||
              !controllers.length
            }
            onClick={prepare}
          >
            Prepare exact desktop for review
          </button>
        </details>
      )}
      {state && (
        <label className="mt-3 block text-xs">
          Shared-computer session
          <select
            className={FIELD}
            value={selection}
            disabled={busy}
            onChange={(e) => {
              clearImage();
              setSelection(e.target.value);
              setReview("");
              setText("");
            }}
          >
            <option value="">Choose a session. None selected.</option>
            {state.sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.state} · {s.id.slice(-8)} · v{s.version}
              </option>
            ))}
          </select>
        </label>
      )}
      {session && (
        <article className="mt-3 min-w-0 border border-[var(--line)] p-3">
          <h4 className="text-sm font-semibold">{session.state} · offline human desktop</h4>
          <dl className="mt-2 grid min-w-0 gap-2 text-xs">
            <div>
              <dt>Frozen owner / funding operator</dt>
              <dd className="break-all">
                {session.contract.ownerId} / {session.contract.funderId}
              </dd>
            </div>
            <div>
              <dt>Display audience</dt>
              <dd className="break-all">{session.contract.viewers.join(", ")}</dd>
            </div>
            <div>
              <dt>Named controllers</dt>
              <dd className="break-all">{session.contract.controllers.join(", ")}</dd>
            </div>
            <div>
              <dt>Expiry and resources</dt>
              <dd>
                {new Date(session.contract.expiresAt).toLocaleString()} ·{" "}
                {session.contract.instance} · 0.5 vCPU / 4 GiB / 8 GB · maximum one deployment
                allocation
              </dd>
            </div>
            <div>
              <dt>Container overage estimate</dt>
              <dd>
                ${session.contract.estimatedContainerOverageUsd.toFixed(3)} ·{" "}
                {session.contract.estimateNotice}
              </dd>
            </div>
            <div>
              <dt>Exact image and approval digest</dt>
              <dd className="break-all font-mono text-[10px]">
                {session.contract.image}
                <br />
                {session.digest}
              </dd>
            </div>
          </dl>
          <details className="mt-3 min-w-0 text-xs">
            <summary className="min-h-11 cursor-pointer">
              Review complete frozen resource and input policy
            </summary>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words">
              {JSON.stringify(session.contract, null, 2)}
            </pre>
          </details>
          {(session.canFund || session.canStart) && (
            <label className="mt-3 flex min-h-11 items-start gap-2 text-xs">
              <input
                type="checkbox"
                checked={review === reviewKey}
                disabled={busy || !current || blocked.includes(session.id)}
                onChange={(e) => setReview(e.target.checked ? reviewKey : "")}
              />
              <span>
                {session.canFund
                  ? "I reviewed this exact image, owner, viewers, controllers, fixed expiry, resources and estimate. As the bootstrap operator/current manager, I explicitly authorize this deployment's container billing. This is not a provider invoice cap."
                  : "I reviewed this exact offline image, full display audience, named control scope, expiry and resource policy. I consent to sharing the entire display and starting this separate computer. I will not enter credentials or private information outside this audience."}
              </span>
            </label>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {session.canFund && (
              <button
                type="button"
                className={BUTTON}
                disabled={busy || !current || review !== reviewKey || blocked.includes(session.id)}
                onClick={() => {
                  void perform(`fund:${reviewKey}`, session.id, async () => {
                    const next = await client.fund(session, abort.current.signal);
                    if (mounted.current) {
                      update(next);
                      setNotice(
                        "Funding approval returned. The owner must separately review and start this exact desktop.",
                      );
                    }
                  });
                }}
              >
                Authorize exact desktop funding
              </button>
            )}
            {session.canStart && (
              <button
                type="button"
                className={BUTTON}
                disabled={busy || !current || review !== reviewKey || blocked.includes(session.id)}
                onClick={() => {
                  void perform(`start:${reviewKey}`, session.id, async () => {
                    const next = await client.start(session, abort.current.signal);
                    if (mounted.current) {
                      update(next);
                      setNotice("Start receipt returned. Choose a human control lease separately.");
                    }
                  });
                }}
              >
                Start reviewed offline computer
              </button>
            )}
            {session.canControl && (
              <button
                type="button"
                className={BUTTON}
                disabled={
                  busy ||
                  !current ||
                  Boolean(session.lease && session.lease.expiresAt > now) ||
                  blocked.includes(session.id)
                }
                onClick={() => {
                  void perform(`lease:${reviewKey}`, session.id, async () => {
                    const next = await client.lease(session, abort.current.signal);
                    if (mounted.current) update(next);
                  });
                }}
              >
                Claim exclusive 60-second control
              </button>
            )}
            {session.canView && (
              <button
                type="button"
                className={BUTTON}
                disabled={busy || !current || blocked.includes(session.id)}
                onClick={() => {
                  void perform(`capture:${reviewKey}:${Date.now()}`, session.id, async () => {
                    const blob = await client.capture(session, abort.current.signal);
                    const checked = await client.state(abort.current.signal);
                    if (!mounted.current) return;
                    adopt(checked);
                    const selected = checked.sessions.find((s) => s.id === session.id);
                    if (
                      !selected?.canView ||
                      selected.state !== "running" ||
                      selected.digest !== session.digest ||
                      selected.contract.expiresAt <= Date.now() ||
                      latches.current.has(`stop:${session.id}`)
                    )
                      return;
                    const url = URL.createObjectURL(blob);
                    objectUrl.current = url;
                    setImage({
                      url,
                      sessionId: session.id,
                      digest: session.digest,
                      expiresAt: Math.min(Date.now() + 5000, selected.contract.expiresAt),
                    });
                  });
                }}
              >
                Capture current display
              </button>
            )}
          </div>
          {session.lease && (
            <p className="mt-3 break-all text-xs">
              Exclusive control: {session.lease.ownerId} · lease v{session.lease.version} · expires{" "}
              {new Date(session.lease.expiresAt).toLocaleTimeString()}
            </p>
          )}
          {image?.sessionId === session.id && (
            <figure className="mt-3">
              <button
                type="button"
                className="block w-full border border-[var(--line)]"
                disabled={busy || !lease}
                aria-label="Click shared desktop; keyboard activation clicks its center"
                onClick={(event) => {
                  if (!lease) return;
                  const bounds = event.currentTarget.getBoundingClientRect();
                  send({
                    type: "click",
                    x:
                      event.detail === 0
                        ? 512
                        : Math.min(
                            1023,
                            Math.max(
                              0,
                              Math.floor(((event.clientX - bounds.left) / bounds.width) * 1024),
                            ),
                          ),
                    y:
                      event.detail === 0
                        ? 384
                        : Math.min(
                            767,
                            Math.max(
                              0,
                              Math.floor(((event.clientY - bounds.top) / bounds.height) * 768),
                            ),
                          ),
                    button: "left",
                  });
                }}
              >
                <img
                  className="h-auto w-full"
                  src={image.url}
                  alt="Current private offline computer display"
                  width={1024}
                  height={768}
                />
              </button>
              <figcaption className="mt-1 text-xs">
                Manual capture, not live video. Cleared after five seconds or a scope/access change.
                Click only while you hold exclusive control.
              </figcaption>
            </figure>
          )}
          {session.state === "running" && (
            <fieldset
              className="mt-3 min-w-0 border border-[var(--line)] p-3"
              disabled={busy || !lease}
            >
              <legend className="px-1 text-xs">Human input for my current exclusive lease</legend>
              <label className="block text-xs">
                Literal shared text
                <textarea
                  className={`${FIELD} min-h-20`}
                  value={text}
                  maxLength={1024}
                  onChange={(e) => setText(e.target.value)}
                />
              </label>
              <button
                type="button"
                className={`${BUTTON} mt-2`}
                disabled={busy || !lease || !text || new TextEncoder().encode(text).length > 1024}
                onClick={() => send({ type: "type", text })}
              >
                Type exact shared text
              </button>
              <div className="mt-2 flex flex-wrap gap-2">
                {(["Tab", "Return", "BackSpace", "Escape"] as const).map((key) => (
                  <button
                    type="button"
                    className={BUTTON}
                    key={key}
                    onClick={() => send({ type: "key", key })}
                  >
                    {key}
                  </button>
                ))}
                {(["up", "down"] as const).map((direction) => (
                  <button
                    type="button"
                    className={BUTTON}
                    key={direction}
                    onClick={() => send({ type: "scroll", direction, ticks: 1 })}
                  >
                    Scroll {direction}
                  </button>
                ))}
              </div>
            </fieldset>
          )}
          {(!current || session.unavailableReason || blocked.includes(session.id)) && (
            <p role="status" className="mt-3 text-xs">
              {session.unavailableReason ??
                "This session is expired, stale or has an unconfirmed action."}{" "}
              Further control is unavailable. Nothing is retried or transferred to another computer.
            </p>
          )}
        </article>
      )}
      {stops.map((item) => (
        <button
          type="button"
          key={item.id}
          className={`${BUTTON} mt-3`}
          disabled={stopping.includes(item.id) || latches.current.has(`stop:${item.id}`)}
          onClick={() => {
            void stop(item);
          }}
        >
          Stop dedicated desktop {item.id.slice(-8)}
        </button>
      ))}
    </section>
  );
}
