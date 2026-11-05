import {
  SHARED_COMPUTER_LIMITS,
  type SharedComputerAction,
  type SharedComputerPrepare,
  type SharedComputerSession,
  type SharedComputerState,
  sharedComputerFundingSchema,
  sharedComputerInputSchema,
  sharedComputerLeaseSchema,
  sharedComputerPrepareSchema,
  sharedComputerResponseSchema,
  sharedComputerStartSchema,
  sharedComputerStateSchema,
  sharedComputerVersionSchema,
} from "@shiba/shared";
import { teamWorkspaceHeaders } from "./team-workspaces-client";

export class SharedComputerRequestError extends Error {
  constructor(readonly status: number) {
    super(
      [401, 403, 404].includes(status)
        ? "Current native workspace or shared-computer access is unavailable."
        : status === 409
          ? "The computer, approval, control lease or source changed. Refresh its state before continuing."
          : status === 429
            ? "This computer reached its capture or input limit."
            : "The response is unconfirmed. Inspect current state; the action will not be retried automatically.",
    );
  }
}
async function bytes(response: Response, limit: number, signal: AbortSignal) {
  const reader = response.body?.getReader();
  if (!reader) throw new SharedComputerRequestError(503);
  const buffer = new Uint8Array(limit);
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      if (size + part.value.byteLength > limit) throw new SharedComputerRequestError(503);
      buffer.set(part.value, size);
      size += part.value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  signal.throwIfAborted();
  return buffer.slice(0, size);
}
export type SharedComputerScope = { workspaceId: string; roomId: string; actorId: string };
type ExpectedReceipt =
  | { kind: "prepare"; input: SharedComputerPrepare }
  | { kind: "fund" | "start" | "lease" | "input"; session: SharedComputerSession };
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export class SharedComputerClient {
  constructor(
    readonly scope: SharedComputerScope,
    private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}
  async #fetch(path: string, signal: AbortSignal, body?: unknown) {
    signal.throwIfAborted();
    const response = await this.fetcher(`/api/shared-computers${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...teamWorkspaceHeaders(this.scope.workspaceId),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    signal.throwIfAborted();
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new SharedComputerRequestError(response.status);
    }
    return response;
  }
  async state(signal: AbortSignal): Promise<SharedComputerState> {
    const response = await this.#fetch(
      `/state?roomId=${encodeURIComponent(this.scope.roomId)}`,
      signal,
    );
    const data = sharedComputerStateSchema.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(await bytes(response, 262144, signal)),
      ),
    );
    if (
      data.workspaceId !== this.scope.workspaceId ||
      data.roomId !== this.scope.roomId ||
      data.actorId !== this.scope.actorId ||
      data.sessions.some((item) => item.roomId !== this.scope.roomId)
    )
      throw new SharedComputerRequestError(403);
    for (const session of data.sessions) this.#scope(session);
    return data;
  }
  #scope(session: SharedComputerSession) {
    if (session.roomId !== this.scope.roomId || session.contract.roomId !== this.scope.roomId)
      throw new SharedComputerRequestError(403);
    const { actorId } = this.scope,
      c = session.contract;
    if (
      (session.canFund && (actorId !== c.funderId || session.state !== "draft")) ||
      (session.canStart && (actorId !== c.ownerId || session.state !== "funded")) ||
      (session.canControl && (!c.controllers.includes(actorId) || session.state !== "running")) ||
      (session.canView && (!c.viewers.includes(actorId) || session.state !== "running")) ||
      (session.canStop && actorId !== c.ownerId && actorId !== c.funderId)
    )
      throw new SharedComputerRequestError(403);
  }
  async #write(path: string, body: unknown, signal: AbortSignal, expected: ExpectedReceipt) {
    const frozen = structuredClone(expected);
    const response = await this.#fetch(path, signal, body);
    const parsed = sharedComputerResponseSchema.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(await bytes(response, 32768, signal)),
      ),
    );
    this.#scope(parsed.session);
    const next = parsed.session;
    if (frozen.kind === "prepare") {
      const input = frozen.input;
      if (
        next.version !== 1 ||
        next.state !== "draft" ||
        next.consumed ||
        next.lease ||
        next.inputCount !== 0 ||
        next.frameCount !== 0 ||
        next.nextSequence !== 1 ||
        next.contract.ownerId !== this.scope.actorId ||
        next.contract.funderId !== input.fundingMember.userId ||
        next.contract.expiresAt !== input.expiresAt ||
        canonical([...next.contract.viewers].sort()) !==
          canonical(input.viewers.map((m) => m.userId).sort()) ||
        canonical([...next.contract.controllers].sort()) !==
          canonical([...input.controllers].sort())
      )
        throw new SharedComputerRequestError(409);
    } else {
      const before = frozen.session;
      if (
        next.id !== before.id ||
        next.digest !== before.digest ||
        canonical(next.contract) !== canonical(before.contract)
      )
        throw new SharedComputerRequestError(409);
      const delta = frozen.kind === "start" ? 2 : frozen.kind === "input" ? 0 : 1;
      const state = frozen.kind === "fund" ? "funded" : "running";
      if (
        next.version !== before.version + delta ||
        next.state !== state ||
        (frozen.kind === "fund" ? next.consumed : !next.consumed)
      )
        throw new SharedComputerRequestError(409);
      if (
        frozen.kind === "lease" &&
        (!next.lease ||
          next.lease.ownerId !== this.scope.actorId ||
          next.lease.expiresAt <= Date.now() ||
          next.lease.expiresAt > Math.min(Date.now() + 60000, next.contract.expiresAt))
      )
        throw new SharedComputerRequestError(409);
      if (
        frozen.kind === "input" &&
        (next.nextSequence !== before.nextSequence + 1 ||
          next.inputCount !== before.inputCount + 1 ||
          canonical(next.lease) !== canonical(before.lease))
      )
        throw new SharedComputerRequestError(409);
    }
    return parsed.session;
  }
  prepare(input: SharedComputerPrepare, signal: AbortSignal) {
    const body = sharedComputerPrepareSchema.parse(input);
    if (body.roomId !== this.scope.roomId) throw new SharedComputerRequestError(403);
    return this.#write("/sessions/prepare", body, signal, { kind: "prepare", input: body });
  }
  fund(session: SharedComputerSession, signal: AbortSignal) {
    this.#scope(session);
    return this.#write(
      `/sessions/${session.id}/fund`,
      sharedComputerFundingSchema.parse({
        expectedVersion: session.version,
        digest: session.digest,
        reviewed: true,
        billingConsent: true,
      }),
      signal,
      { kind: "fund", session },
    );
  }
  start(session: SharedComputerSession, signal: AbortSignal) {
    this.#scope(session);
    return this.#write(
      `/sessions/${session.id}/start`,
      sharedComputerStartSchema.parse({
        expectedVersion: session.version,
        digest: session.digest,
        reviewed: true,
        sharedDisplayConsent: true,
      }),
      signal,
      { kind: "start", session },
    );
  }
  lease(session: SharedComputerSession, signal: AbortSignal) {
    this.#scope(session);
    return this.#write(
      `/sessions/${session.id}/lease`,
      sharedComputerLeaseSchema.parse({
        expectedVersion: session.version,
        digest: session.digest,
        leaseMs: 60000,
      }),
      signal,
      { kind: "lease", session },
    );
  }
  input(
    session: SharedComputerSession,
    action: SharedComputerAction,
    requestId: string,
    signal: AbortSignal,
  ) {
    this.#scope(session);
    if (!session.lease || session.lease.ownerId !== this.scope.actorId)
      throw new SharedComputerRequestError(403);
    return this.#write(
      `/sessions/${session.id}/input`,
      sharedComputerInputSchema.parse({
        expectedVersion: session.version,
        digest: session.digest,
        leaseVersion: session.lease.version,
        sequence: session.nextSequence,
        requestId,
        action,
      }),
      signal,
      { kind: "input", session },
    );
  }
  async capture(session: SharedComputerSession, signal: AbortSignal): Promise<Blob> {
    this.#scope(session);
    const response = await this.#fetch(
      `/sessions/${session.id}/capture`,
      signal,
      sharedComputerVersionSchema.parse({ expectedVersion: session.version }),
    );
    if (
      response.headers.get("content-type")?.split(";")[0] !== "image/jpeg" ||
      !response.headers.get("cache-control")?.includes("no-store")
    ) {
      await response.body?.cancel().catch(() => {});
      throw new SharedComputerRequestError(503);
    }
    const image = await bytes(response, SHARED_COMPUTER_LIMITS.maxFrameBytes, signal);
    if (
      image.length < 4 ||
      image[0] !== 255 ||
      image[1] !== 216 ||
      image.at(-2) !== 255 ||
      image.at(-1) !== 217
    )
      throw new SharedComputerRequestError(503);
    return new Blob([image], { type: "image/jpeg" });
  }
  async stop(
    session: Pick<SharedComputerSession, "id" | "roomId" | "version">,
    signal: AbortSignal,
  ) {
    if (session.roomId !== this.scope.roomId || !/^scs_[a-f0-9]{32}$/.test(session.id))
      throw new SharedComputerRequestError(403);
    const response = await this.#fetch(
      `/sessions/${session.id}/stop`,
      signal,
      sharedComputerVersionSchema.parse({ expectedVersion: session.version }),
    );
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(await bytes(response, 1024, signal)),
    );
    if (value?.ok !== true || value?.stopped !== true || Object.keys(value).length !== 2)
      throw new SharedComputerRequestError(503);
  }
}
