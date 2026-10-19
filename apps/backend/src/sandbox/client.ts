/**
 * Replacement for @cloudflare/sandbox getSandbox — returns a typed facade over
 * the Sandbox Durable Object stub (SDK 1.0).
 */
import { resolveSandboxDurableObjectId } from "@shiba/shared";
import type { Sandbox } from "./durable-object.js";

export type SandboxHandle = ReturnType<typeof getSandbox>;

export function getSandbox(
  namespace: DurableObjectNamespace<Sandbox>,
  sandboxId: string,
): DurableObjectStub<Sandbox> & SandboxRpcFacade {
  const id = resolveSandboxDurableObjectId(namespace, sandboxId);
  const stub = namespace.get(id) as DurableObjectStub<Sandbox> & SandboxRpcFacade;
  return wrapSandboxStub(stub, sandboxId);
}

/** Minimal RPC surface for @shiba/sandbox Cloudflare adapter and tests. */
export type SandboxRpcFacade = Pick<
  Sandbox,
  | "approveHarnessEgress"
  | "approveEgressOverrides"
  | "approveRepoScope"
  | "gitCheckout"
  | "writeFile"
  | "exec"
  | "readFileStream"
  | "destroy"
  | "exposePort"
  | "unexposePort"
  | "startProcess"
  | "getContainerPlacementId"
  | "listProcesses"
  | "listFiles"
  | "readFile"
  | "snapshotContainer"
>;

function wrapSandboxStub(
  stub: DurableObjectStub<Sandbox>,
  sandboxId: string,
): DurableObjectStub<Sandbox> & SandboxRpcFacade {
  const touch = () => stub.registerSandboxName(sandboxId);
  return new Proxy(stub, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      if (prop === "registerSandboxName") return value;
      return async (...args: unknown[]) => {
        await touch();
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as DurableObjectStub<Sandbox> & SandboxRpcFacade;
}
