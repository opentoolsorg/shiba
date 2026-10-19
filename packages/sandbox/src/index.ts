export { SandboxError, isSandboxError, type SandboxErrorCode } from "./errors.js";
export {
  type BackgroundProcess,
  type BuiltinSandboxProviderId,
  type ExecResult,
  type ExposePortOptions,
  type PreviewPortGateway,
  type ReadFileResult,
  type ResolveSandboxProviderOptions,
  type SandboxCapabilities,
  type SandboxEgressPin,
  type SandboxInstance,
  type SandboxProvider,
  type SandboxProviderFactory,
  type SandboxProviderId,
} from "./types.js";
export {
  type CloudflareProviderOptions,
  type ComputesdkProviderOptions,
  type DockerLocalProviderOptions,
  type ParsedSandboxProviderConfig,
  type SandboxCommonOptions,
  type SandboxProviderEnvInput,
  parseSandboxProviderConfig,
} from "./options.js";
export { assertProviderAllowed, parseSandboxProviderId } from "./resolve.js";
export type { SandboxHostDeps } from "./host-deps.js";
export {
  clearSandboxProviderRegistry,
  createSandboxProviderFromRegistry,
  createSandboxProviderFromRegistrySync,
  getSandboxProviderFactory,
  listRegisteredSandboxProviders,
  registerSandboxProvider,
  type SandboxProviderFactoryContext,
  unregisterSandboxProvider,
} from "./registry.js";
export { registerBuiltinSandboxProviders } from "./register-builtins.js";
export { describeSandboxProviderContract } from "./contract-suite.js";

import { registerBuiltinSandboxProviders } from "./register-builtins.js";
registerBuiltinSandboxProviders();
