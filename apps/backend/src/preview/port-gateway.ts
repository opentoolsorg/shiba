/**
 * Preview port exposure behind a narrow interface. Today this wraps Sandbox
 * SDK 0.12 `exposePort` / `unexposePort`; a Sandbox 1.0 migration can swap
 * the implementation to port forwarding without touching browser E2E callers.
 */
export interface PreviewPortExposeOptions {
  hostname: string;
}

export interface PreviewPortGateway {
  expose(port: number, options: PreviewPortExposeOptions): Promise<{ url: string }>;
  unexpose(port: number): Promise<void>;
}

export interface SandboxPortForwardSource {
  exposePort(port: number, options: PreviewPortExposeOptions): Promise<{ url: string }>;
  unexposePort(port: number): Promise<void>;
}

export function createSandboxPortGateway(source: SandboxPortForwardSource): PreviewPortGateway {
  return {
    expose: (port, options) => source.exposePort(port, options),
    unexpose: (port) => source.unexposePort(port),
  };
}
