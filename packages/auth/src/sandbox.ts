/** SDK 1.0: resolve a sandbox Durable Object stub by the run's sandbox id. */
export function getSandbox(namespace: DurableObjectNamespace, sandboxId: string): DurableObjectStub {
  return namespace.get(namespace.idFromString(sandboxId));
}
