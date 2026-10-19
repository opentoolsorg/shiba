/** Workers `idFromString` accepts only a 64-char hex `DurableObjectId.toString()` value. */
const DO_ID_STRING_RE = /^[0-9a-f]{64}$/i;

export interface SandboxDurableObjectNamespace<TId = unknown> {
  idFromName(name: string): TId;
  idFromString(id: string): TId;
}

/** Resolve a run-scoped sandbox name (`run-…`) or a persisted DO id string. */
export function resolveSandboxDurableObjectId<TId>(
  namespace: SandboxDurableObjectNamespace<TId>,
  sandboxId: string,
): TId {
  if (DO_ID_STRING_RE.test(sandboxId)) {
    return namespace.idFromString(sandboxId);
  }
  return namespace.idFromName(sandboxId);
}
