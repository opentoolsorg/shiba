import type {
  IntegrationCatalogEntry,
  IntegrationConnectionPhase,
  IntegrationConnectionSnapshot,
  IntegrationNativeBinding,
} from "@shiba/shared";
import type { SetupStatus } from "./live-status";

export type IntegrationBindingInputs = {
  setupLoading: boolean;
  setup?: SetupStatus;
  mailboxCount: number | undefined;
  mailboxLoading: boolean;
  gmailConnected: boolean | null;
  gmailLoading: boolean;
  externalMcpServerCount: number | undefined;
  externalMcpLoading: boolean;
};

function bindingPhase(
  loading: boolean,
  configured: boolean,
  partial: boolean,
  deploymentOnly = false,
): IntegrationConnectionPhase {
  if (loading) return "loading";
  if (deploymentOnly) return "available_via_deployment";
  if (configured) return "configured";
  if (partial) return "partial";
  return "not_set_up";
}

function phaseForBinding(
  binding: IntegrationNativeBinding,
  inputs: IntegrationBindingInputs,
): IntegrationConnectionPhase {
  const { setup, setupLoading } = inputs;
  switch (binding) {
    case "github": {
      const github = setup?.github;
      return bindingPhase(
        setupLoading,
        Boolean(github?.publish && github?.webhookSecret),
        Boolean(github?.publish || github?.webhookSecret || github?.app),
      );
    }
    case "linear": {
      const linear = setup?.linear;
      return bindingPhase(
        setupLoading,
        Boolean(linear?.webhookSecret && linear?.apiToken && linear?.defaultRepo),
        Boolean(linear?.webhookSecret || linear?.apiToken || linear?.defaultRepo),
      );
    }
    case "slack": {
      const slack = setup?.slack;
      const configured = Boolean(slack?.signingSecret && slack?.botToken && (slack?.approvers ?? 0) > 0);
      const partial = Boolean(
        slack?.signingSecret || slack?.botToken || (slack?.approvers ?? 0) > 0 || slack?.channelRepos,
      );
      return bindingPhase(setupLoading, configured, partial);
    }
    case "telegram":
    case "discord":
    case "generic_webhook":
      return bindingPhase(setupLoading, false, false, true);
    case "mailbox":
      return bindingPhase(
        inputs.mailboxLoading,
        (inputs.mailboxCount ?? 0) > 0,
        false,
      );
    case "gmail":
      if (inputs.gmailLoading) return "loading";
      if (inputs.gmailConnected === true) return "configured";
      if (inputs.gmailConnected === false) return "not_set_up";
      return "not_set_up";
    case "external_mcp":
      return bindingPhase(
        inputs.externalMcpLoading,
        (inputs.externalMcpServerCount ?? 0) > 0,
        false,
      );
    default:
      return "not_set_up";
  }
}

export function buildIntegrationConnectionSnapshot(
  entries: IntegrationCatalogEntry[],
  inputs: IntegrationBindingInputs,
): IntegrationConnectionSnapshot {
  const snapshot: IntegrationConnectionSnapshot = {};
  for (const entry of entries) {
    if (entry.status === "catalog_only" && !entry.nativeBinding) {
      snapshot[entry.id] = "catalog_only";
      continue;
    }
    if (entry.nativeBinding) {
      snapshot[entry.id] = phaseForBinding(entry.nativeBinding, inputs);
      continue;
    }
    snapshot[entry.id] = entry.status === "catalog_only" ? "catalog_only" : "not_set_up";
  }
  return snapshot;
}

export function connectionPhaseLabel(phase: IntegrationConnectionPhase): {
  tone: "neutral" | "pending" | "ok";
  label: string;
} {
  switch (phase) {
    case "loading":
      return { tone: "neutral", label: "Checking…" };
    case "catalog_only":
      return { tone: "neutral", label: "Catalog only" };
    case "not_set_up":
      return { tone: "neutral", label: "Not set up" };
    case "partial":
      return { tone: "pending", label: "Needs attention" };
    case "configured":
      return { tone: "ok", label: "Connected" };
    case "available_via_deployment":
      return { tone: "neutral", label: "Available via deployment" };
    default:
      return { tone: "neutral", label: "Unknown" };
  }
}
