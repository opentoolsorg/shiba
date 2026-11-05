import path from "node:path";
import fs from "node:fs/promises";
import { validatePersonalSelection } from "./personal-cli-auth.mjs";

const unavailable = () => new Error("Personal execution authorization or selected account changed; approve a new task after reconnecting.");
const hash = /^[a-f0-9]{64}$/;
const positive = (value) => Number.isSafeInteger(value) && value > 0;

export function validatePersonalBinding(value, origin) {
  const scope = value?.scope;
  if (value?.version !== 1 || scope?.version !== 2 || scope.origin !== origin ||
      new URL(origin).protocol !== "https:" || new URL(origin).origin !== origin ||
      !/^ws_[a-f0-9]{24}$/.test(scope.workspaceId) || !positive(scope.membershipVersion) ||
      !["owner", "admin", "member"].includes(scope.membershipRole) ||
      typeof scope.ownerAccountId !== "string" || !scope.ownerAccountId ||
      typeof scope.actorId !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(scope.actorId)) throw unavailable();
  return value;
}

/** Local defense in depth; the authenticated Worker owns approval/hash/grant verification. */
export function assertPersonalEnvelope(envelope, { binding, selection, machineId, receipt, now = Date.now() }) {
  const selected = validatePersonalSelection(selection), proof = envelope?.personalExecution;
  const snapshot = proof?.snapshot, scope = binding?.scope;
  if (!scope || !snapshot || snapshot.version !== 1 ||
      ["ownerAccountId", "actorId", "workspaceId", "membershipVersion"].some((key) => snapshot[key] !== scope[key]) ||
      snapshot.machineId !== machineId || !positive(snapshot.machineRevision) || !positive(snapshot.grantVersion) ||
      !/^plex_[a-f0-9]{32}$/.test(snapshot.grantId) ||
      snapshot.harness !== selected.harness || snapshot.billingMode !== selected.billingMode ||
      snapshot.accountFingerprint !== selected.accountFingerprint || !hash.test(snapshot.authVersion) ||
      receipt?.accountFingerprint !== snapshot.accountFingerprint || receipt?.authVersion !== snapshot.authVersion ||
      receipt.harness !== snapshot.harness || receipt.billingMode !== snapshot.billingMode ||
      receipt.probedAt > now + 5000 || now - receipt.probedAt > 75_000 ||
      !positive(proof.approvedUntil) || !positive(snapshot.expiresAt) ||
      Math.min(proof.approvedUntil, snapshot.expiresAt, envelope.deadlineAt) <= now ||
      !Array.isArray(snapshot.allowedPhases) || snapshot.allowedPhases.length !== 1 || snapshot.allowedPhases[0] !== "local_repository_task" ||
      ["approvalId", "inputHash", "executionOwner", "handoffId", "contextDigest"].some((key) => typeof proof[key] !== "string" || !proof[key]) ||
      !hash.test(proof.inputHash) || !hash.test(proof.contextDigest) || !Number.isSafeInteger(proof.generation) || proof.generation < 0 ||
      !/^https:\/\/github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(snapshot.repoUrl) || snapshot.repoUrl !== envelope.repoUrl ||
      envelope.orgId !== `team:${scope.workspaceId}` || !envelope.customAgentId || !envelope.customAgentVersion ||
      envelope.harness !== snapshot.harness || !/^[a-zA-Z0-9_-]{1,128}$/.test(envelope.sandboxId) ||
      envelope.cloneDir !== "${SHIBA_LOCAL_RUN_ROOT}/work" || envelope.homeDir !== "${SHIBA_LOCAL_RUN_ROOT}/home" ||
      !Array.isArray(envelope.setupCommands) || envelope.setupCommands.length || !Array.isArray(envelope.configFiles) || envelope.configFiles.length ||
      !envelope.env || Object.keys(envelope.env).length || envelope.testCommand?.length ||
      !envelope.session || envelope.session.permissionMode !== "approval-required" ||
      envelope.session.bin || envelope.session.binArgs?.length || envelope.session.resumeThreadId ||
      envelope.session.provider !== (snapshot.harness === "claude-code" ? "claude" : "codex") ||
      !new RegExp(`^${snapshot.harness === "claude-code" ? "anthropic" : "openai"}/[a-zA-Z0-9][a-zA-Z0-9._-]*$`).test(snapshot.codingModel) ||
      envelope.session.model !== snapshot.codingModel.split("/")[1] ||
      typeof envelope.baseBranch !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/.test(envelope.baseBranch) || envelope.baseBranch.includes("..")) throw unavailable();
  return snapshot;
}

export function personalGitArgs(args) {
  return ["git", "-c", "credential.helper=", "-c", "core.askPass=", "-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
    "-c", "protocol.file.allow=never", "-c", "protocol.ext.allow=never", "-c", "http.followRedirects=false", ...args];
}

export function personalSessionOptions(harness) {
  return harness === "claude-code"
    ? { binArgs: ["--safe-mode", "--setting-sources", "user", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--tools", "Bash,Edit,Read,Write,Grep,Glob,NotebookEdit", "--disallowedTools", "mcp__*"] }
    : { launchArgs: ['model_provider="openai"', 'cli_auth_credentials_store="file"', "features.apps=false", "features.hooks=false", "features.multi_agent=false", "features.goals=false", "features.plugins=false", "features.memories=false", "mcp_servers={}"] };
}

export async function assertPersonalConfigurationSafe(cloneDir, harness) {
  // This initial lane has no reviewed contract for project/managed CLI hooks,
  // alternate inference endpoints, MCPs, or connector configuration.
  const paths = harness === "codex" ? [path.join(cloneDir, ".codex"), "/etc/codex/config.toml", "/etc/codex/managed_config.toml", "/etc/codex/requirements.toml"]
    : [path.join(cloneDir, ".claude"), path.join(cloneDir, ".mcp.json"), "/etc/claude-code/managed-settings.json", "/etc/claude-code/managed-settings.d", "/etc/claude-code/managed-mcp.json"];
  for (const candidate of paths) {
    try { await fs.lstat(candidate); }
    catch (error) { if (error.code === "ENOENT") continue; throw unavailable(); }
    throw new Error("Personal execution with project or managed CLI configuration is unavailable.");
  }
}

export function personalRunPaths(runRoot, sandboxId) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sandboxId)) throw unavailable();
  const root = path.join(runRoot, "runs", sandboxId);
  return { root, cloneDir: path.join(root, "work"), homeDir: path.join(root, "home") };
}

