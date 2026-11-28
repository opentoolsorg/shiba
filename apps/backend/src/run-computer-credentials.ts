import type { CodingTaskInput } from "./opencode-input.js";

export function runComputerCredentialIssue(
  harness: string | undefined,
  input: Pick<CodingTaskInput, "codexAuthMode" | "chatgptAccessToken">,
): string | undefined {
  if (harness === "antigravity-subscription" || harness === "claude-login" ||
      input.codexAuthMode === "device-auth" || input.chatgptAccessToken !== undefined) {
    return "A cloud computer requires Worker-managed credentials. Choose a route without an in-container login.";
  }
}
