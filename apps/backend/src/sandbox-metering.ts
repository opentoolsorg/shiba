import { isTerminalStatus, type DelegatedRun, type SandboxMeter } from "@shiba/shared";
import { DEFAULT_INSTANCE_TYPE, type InstanceType } from "./instance-type.js";

export const SANDBOX_PRICING_VERSION = "cloudflare-containers-2026-11-13";
export const SANDBOX_RESOURCES: Record<InstanceType, { cpu: number; ram: number; disk: number }> = {
  lite: { cpu: 1 / 16, ram: 0.25, disk: 2 },
  basic: { cpu: 0.25, ram: 1, disk: 4 },
  "standard-1": { cpu: 0.5, ram: 4, disk: 8 },
  "standard-2": { cpu: 1, ram: 6, disk: 12 },
  "standard-3": { cpu: 2, ram: 8, disk: 16 },
  "standard-4": { cpu: 4, ram: 12, disk: 20 },
};

/** Provisioned-capacity estimate, not observed CPU usage or an invoice. */
export function meterSandboxRun(
  run: DelegatedRun,
  now = Date.now(),
  instanceType: InstanceType = DEFAULT_INSTANCE_TYPE,
  freeze = false,
): SandboxMeter {
  if (run.sandboxMeter) return run.sandboxMeter;
  const empty = (status: SandboxMeter["status"]): SandboxMeter => ({
    status, cpuSeconds: 0, ramGbSeconds: 0, diskGbSeconds: 0, costUsd: 0, provenance: null,
  });
  if (run.runtime === "local") return empty("not_applicable");
  if (isTerminalStatus(run.status) && !freeze) return empty("unavailable");
  const startedAt = run.signals?.find((signal) => signal.kind === "sandbox.ready")?.at;
  if (startedAt === undefined) return empty("not_started");
  const endedAt = isTerminalStatus(run.status) ? run.updatedAt : now;
  const seconds = Math.max(0, endedAt - startedAt) / 1000;
  const size = SANDBOX_RESOURCES[instanceType];
  const cpuSeconds = seconds * size.cpu;
  const ramGbSeconds = seconds * size.ram;
  const diskGbSeconds = seconds * size.disk;
  return {
    status: "estimated", cpuSeconds, ramGbSeconds, diskGbSeconds,
    costUsd: cpuSeconds * 0.000020 + ramGbSeconds * 0.0000025 + diskGbSeconds * 0.00000007,
    provenance: { source: "instance-type-rates", instanceType, pricingVersion: SANDBOX_PRICING_VERSION, startedAt, endedAt },
  };
}
