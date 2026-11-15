import type { AcpProviderCard, AcpProvidersSnapshot } from "@shiba/shared";

/** Match the server's personal default selection without using a disconnected account. */
export function connectedTaskDefault(snapshot: AcpProvidersSnapshot | null | undefined): AcpProviderCard | null {
  const connected = snapshot?.providers?.filter((card) => card.connection.phase === "connected" && card.connection.signInKind !== "claude-daemon") ?? [];
  return connected.find((card) => card.id === snapshot?.defaultProviderId) ??
    (connected.length === 1 ? connected[0]! : null);
}

export interface TaskConnectionSelection {
  id: string;
  label: string;
  status: string;
  service?: string;
}

/** Declared execution support, not a provider login or inference readiness probe. */
export function describeTaskRoute(input: {
  runtime: "sandbox" | "local";
  workType: "repository" | "artifact-workspace" | "connected-app";
  harness: string;
  model: string;
  connectionId: string;
  connections: readonly TaskConnectionSelection[];
}) {
  const connection = input.connections.find((item) => item.id === input.connectionId);
  const local = input.runtime === "local";
  const chatgpt = input.harness === "codex-subscription";
  const legacyClaude = input.harness === "claude-subscription";
  let blockedReason: string | null = null;
  if (input.harness === "claude-login") {
    blockedReason = "Native cloud Claude login is unavailable: per-user persistent auth volumes are not implemented. Choose the API route or paired local Claude Code explicitly.";
  } else if (input.workType === "connected-app") {
    blockedReason = "Connected-app execution is unavailable on CLI routes. Use the separate granted app-tools work target.";
  } else if (local && !["opencode", "claude-code", "codex"].includes(input.harness)) {
    blockedReason = "This harness cannot run on a paired computer. Choose a supported local harness or Cloud explicitly.";
  } else if (!local && input.connectionId && !connection) {
    blockedReason = "The selected model connection is unavailable. Review Providers or choose a route explicitly.";
  } else if (!local && connection && connection.status !== "ready") {
    blockedReason = `The selected model connection is ${connection.status}. Review it in Providers before sending.`;
  } else if (!local && connection?.service === "openai-subscription" && !chatgpt) {
    blockedReason = "This ChatGPT connection requires Codex (ChatGPT plan). Choose that harness explicitly.";
  } else if (!local && chatgpt && connection?.service && connection.service !== "openai-subscription") {
    blockedReason = "Codex (ChatGPT plan) requires a ChatGPT connection. Review the selected route explicitly.";
  }
  return {
    runtime: local ? "Paired local computer" : "Cloud sandbox",
    workType: input.workType === "repository" ? "Repository work" : input.workType === "artifact-workspace" ? "Repository-free artifacts" : "Connected-app work",
    harness: input.harness || "Deployment default (resolved at approval)",
    model: input.model || "Deployment default (resolved at approval)",
    account: local
      ? "Selected computer's CLI credentials; account identity is not reported."
      : chatgpt
        ? "Signed-in user's ChatGPT connection; access and plan consent are checked by the server."
        : connection
          ? `${connection.label} (${connection.service ?? "provider"}); provider account identity is not reported.`
          : "Account route is resolved by the server and frozen for approval.",
    billing: local
      ? "Determined by the local CLI credentials; check the account on that computer."
      : chatgpt ? "ChatGPT plan; requires an attributed human initiator."
      : legacyClaude ? "Your saved Claude setup-token account."
      : "Provider API or gateway account selected by the approved route.",
    note: local
      ? "CLI presence does not verify account access or quota. This task does not reuse a cloud credential."
      : legacyClaude
        ? "Your saved setup-token is attached by Shiba when this task calls Claude, unless an admin disables the subscription lane."
        : "Provider access, model support and quota are validated when used. Starting work still requires human approval.",
    blockedReason,
  };
}

/** A provider card describes configuration; its registry adapter need not be the task harness. */
export function describeProviderRoute(card: AcpProviderCard) {
  const { connection } = card;
  if (card.id === "claude" && connection.signInKind === "claude-daemon") {
    return {
      harness: "claude-code",
      runtime: "Paired local computer · repositories and bounded artifacts",
      account: "Selected computer's CLI account; identity and billing are not reported.",
      note: "Select Local and Claude Code on the task. CLI presence does not verify login or quota. Local artifacts require explicit complete output paths; only approved files are exported.",
    };
  }
  if (card.id === "claude" && connection.signInKind === "claude-setup-token") {
    return {
      harness: "claude-subscription",
      runtime: "Sandbox · repositories and artifacts",
      account: "Your saved setup-token credential; account identity is not reported.",
      note: "Connect with a Claude setup-token, then set Claude as your default for tasks. An admin can disable this subscription lane.",
    };
  }
  if (card.id === "codex" && connection.authMode === "oauth") {
    return {
      harness: "codex-subscription",
      runtime: "Sandbox · repositories and artifacts",
      account: "Signed-in user's ChatGPT plan; no account identity is exposed by this card.",
      note: "Select Codex (ChatGPT plan) on the task. Human attribution and plan consent are required; shared triggers cannot borrow this account.",
    };
  }
  return {
    harness: connection.authMode === "api-key" && card.id === "claude" ? "claude-code or claude-acp (sandbox)"
      : connection.authMode === "api-key" && card.id === "codex" ? "codex or codex-acp (sandbox)" : card.harness,
    runtime: card.id === "claude" || card.id === "codex"
      ? "Sandbox API route; paired local CLI is configured separately"
      : "Selected task's supported runtime",
    account: connection.authMode === "api-key"
      ? "Configured API credential; the provider account and billing identity are not reported."
      : "Choose a connection method; account and billing are not yet established.",
    note: "A saved configuration check does not run the model or verify quota. Review the task harness, model and account route before approval.",
  };
}
