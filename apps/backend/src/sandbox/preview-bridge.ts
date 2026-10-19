import type { SandboxInstance } from "@shiba/sandbox";
import type { PreviewSandbox } from "../preview/types.js";

/** Map generic provider instance to preview/E2E seam (no direct Cloudflare DO calls). */
export function instanceToPreviewSandbox(instance: SandboxInstance): PreviewSandbox {
  if (!instance.startProcess || !instance.exposePort || !instance.unexposePort) {
    throw new Error(`Sandbox provider "${instance.id}" does not support preview capture (ports/processes).`);
  }
  return {
    exec: (command, options) =>
      instance.exec(command, { cwd: options?.cwd, timeoutMs: options?.timeout }).then((r) => ({
        exitCode: r.exitCode,
      })),
    startProcess: (command, options) =>
      instance.startProcess!(command, options).then((proc) => ({
        waitForPort: (port, waitOpts) => proc.waitForPort(port, { timeoutMs: waitOpts?.timeout }),
        kill: () => proc.kill(),
      })),
    expose: (port, options) => instance.exposePort!(port, { hostname: options.hostname }),
    unexpose: (port) => instance.unexposePort!(port),
  };
}
