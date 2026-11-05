import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { isSafePersonalApprovalReview, readPersonalAuthMaterial, stagePersonalAuth } from "./link-operator-auth.mjs";
import { inspectStagedPersonalAccount, personalChildEnvironment, probePersonalAccount, runPersonalAuthCommand } from "./personal-cli-auth.mjs";
import { assertPersonalConfigurationSafe, assertPersonalEnvelope, personalGitArgs, personalResultForTransfer, personalRunPaths, personalSessionOptions, validatePersonalBinding } from "./personal-execution-guard.mjs";

const now = Date.now();
const hash = "a".repeat(64), auth = "b".repeat(64);
const scope = { version: 2, ownerAccountId: "owner-one", actorId: "one@example.test", workspaceId: `ws_${"a".repeat(24)}`, membershipVersion: 1, membershipRole: "member", origin: "https://shiba.example.test" };
const binding = { version: 1, scope };
const selection = { harness: "codex", billingMode: "native-subscription", accountFingerprint: hash };
const receipt = { ...selection, schemaVersion: 1, authVersion: auth, probedAt: now };
function envelope() {
  return { sandboxId: "personal_run_1", harness: "codex", orgId: `team:${scope.workspaceId}`, customAgentId: "engineer", customAgentVersion: 1,
    repoUrl: "https://github.com/example/repo", baseBranch: "main", cloneDir: "${SHIBA_LOCAL_RUN_ROOT}/work", homeDir: "${SHIBA_LOCAL_RUN_ROOT}/home",
    deadlineAt: now + 60000, setupCommands: [], configFiles: [], env: {}, session: { provider: "codex", model: "gpt-5.4", permissionMode: "approval-required" },
    personalExecution: { approvalId: "approval-1", inputHash: hash, generation: 0, contextDigest: hash, executionOwner: "owner-1", handoffId: "handoff-1", approvedUntil: now + 60000,
      snapshot: { ...selection, version: 1, grantId: `plex_${"a".repeat(32)}`, grantVersion: 1, ownerAccountId: scope.ownerAccountId, actorId: scope.actorId, workspaceId: scope.workspaceId, membershipVersion: scope.membershipVersion, machineId: "machine-one", machineRevision: 1,
        authVersion: auth, codingModel: "openai/gpt-5.4", repoUrl: "https://github.com/example/repo", expiresAt: now + 60000, allowedPhases: ["local_repository_task"] } } };
}
const opts = { binding, selection, machineId: "machine-one", receipt, now };
async function homes(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shiba-personal-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const user = path.join(root, "user"), run = path.join(root, "run");
  await fs.mkdir(user); await fs.mkdir(run);
  return { root, user, run };
}
async function writeAuth(home, harness = "codex", extra = {}) {
  const value = harness === "codex" ? { auth_mode: "chatgpt", tokens: { access_token: `header.${Buffer.from(JSON.stringify({ exp: Math.floor(now / 1000) + 3600 })).toString("base64url")}.signature`, refresh_token: "FAKE_REFRESH_SECRET", account_id: "account-one" }, ...extra }
    : { claudeAiOauth: { accessToken: "FAKE_CLAUDE_ACCESS", refreshToken: "FAKE_CLAUDE_REFRESH", expiresAt: now + 3600000, subscriptionType: "pro", ...extra } };
  const directory = path.join(home, harness === "codex" ? ".codex" : ".claude");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, harness === "codex" ? "auth.json" : ".credentials.json"), JSON.stringify(value));
}
const fakeStatus = async (_command, args, options) => args[0] === "--version" ? { stdout: _command === "codex" ? "codex-cli 0.157.1" : "2.1.284 (Claude Code)" }
  : _command === "codex" ? { result: { requiresOpenaiAuth: true, account: { type: "chatgpt", email: "one@example.test", planType: "pro" } } }
    : { stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", configDirectory: path.join(options.homeDir, ".claude"), email: "one@example.test", orgId: "org-one" }) };

test("personal envelope requires exact owner, machine, account, approval, and explicit model", () => {
  assert.equal(assertPersonalEnvelope(envelope(), opts).codingModel, "openai/gpt-5.4");
});
for (const [name, change] of [
  ["other human", e => { e.personalExecution.snapshot.actorId = "two@example.test"; }],
  ["other workspace", e => { e.personalExecution.snapshot.workspaceId = `ws_${"b".repeat(24)}`; }],
  ["other machine", e => { e.personalExecution.snapshot.machineId = "machine-two"; }],
  ["changed membership", e => { e.personalExecution.snapshot.membershipVersion++; }],
  ["expired approval", e => { e.personalExecution.approvedUntil = now; }],
  ["expired grant", e => { e.personalExecution.snapshot.expiresAt = now; }],
  ["auth drift", e => { e.personalExecution.snapshot.authVersion = "c".repeat(64); }],
  ["account drift", e => { e.personalExecution.snapshot.accountFingerprint = "c".repeat(64); }],
  ["model fallback", e => { e.session.model = "default"; }],
  ["provider fallback", e => { e.session.provider = "claude"; }],
  ["permission bypass", e => { e.session.permissionMode = "accept-edits"; }],
  ["setup script", e => { e.setupCommands = [["npm", "install"]]; }],
  ["config injection", e => { e.configFiles = [{ path: "x", contents: "y" }]; }],
  ["ambient key", e => { e.env.OPENAI_API_KEY = "secret"; }],
  ["alternate binary", e => { e.session.bin = "/tmp/other"; }],
  ["alternate argv", e => { e.session.binArgs = ["--dangerously-skip-permissions"]; }],
  ["resume", e => { e.session.resumeThreadId = "old"; }],
  ["test execution", e => { e.testCommand = ["npm", "test"]; }],
  ["unsafe repo", e => { e.repoUrl = e.personalExecution.snapshot.repoUrl = "ssh://github.com/example/repo"; }],
  ["workspace traversal", e => { e.sandboxId = "../sibling"; }],
  ["home redirect", e => { e.homeDir = "/home/operator"; }],
  ["old claim wire", e => { delete e.personalExecution.generation; }],
]) test(`rejects ${name}`, () => { const value = envelope(); change(value); assert.throws(() => assertPersonalEnvelope(value, opts)); });

test("stale/forward-dated receipt and wrong deployment binding fail closed", () => {
  assert.throws(() => assertPersonalEnvelope(envelope(), { ...opts, receipt: { ...receipt, probedAt: now - 75001 } }));
  assert.throws(() => assertPersonalEnvelope(envelope(), { ...opts, receipt: { ...receipt, probedAt: now + 5001 } }));
  assert.throws(() => validatePersonalBinding(binding, "https://other.example.test"));
  assert.throws(() => validatePersonalBinding({ ...binding, scope: { ...scope, origin: "http://example.test" } }, "http://example.test"));
  assert.deepEqual(validatePersonalBinding(binding, scope.origin), binding);
});
test("personal child environment strips alternate auth and Git/provider configuration", () => {
  const env = personalChildEnvironment("/tmp/fresh-home", { PATH: "/bin", OPENAI_API_KEY: "fake", ANTHROPIC_API_KEY: "fake", GITHUB_TOKEN: "fake", LOCAL_ADAPTER_TOKEN: "fake", OPENAI_BASE_URL: "https://other", NODE_OPTIONS: "--import evil", HTTPS_PROXY: "https://proxy", CODEX_HOME: "/old", CLAUDE_CONFIG_DIR: "/old", GIT_CONFIG_COUNT: "2" }, "codex");
  assert.equal(env.PATH, "/bin"); assert.equal(env.CODEX_HOME, "/tmp/fresh-home/.codex");
  for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GITHUB_TOKEN", "LOCAL_ADAPTER_TOKEN", "OPENAI_BASE_URL", "NODE_OPTIONS", "HTTPS_PROXY", "CLAUDE_CONFIG_DIR", "GIT_CONFIG_COUNT"]) assert.equal(env[key], undefined);
  assert.ok(personalGitArgs(["clone"]).includes("credential.helper="));
  assert.ok(personalGitArgs(["clone"]).includes("http.followRedirects=false"));
  assert.ok(personalSessionOptions("codex").launchArgs.includes("features.apps=false"));
  assert.ok(personalSessionOptions("claude-code").binArgs.includes("--safe-mode"));
  assert.throws(() => personalRunPaths("/tmp/run", "../other"));
});
test("personal transfer cap measures complete UTF-8 bytes and returns failure without partial output", () => {
  const ordinary = { status: "completed", summary: "done", files: [{ path: "out.txt", content: "complete", encoding: "utf8" }], diff: "complete" };
  assert.equal(personalResultForTransfer("run", "claim", ordinary), ordinary);
  const oversized = { ...ordinary, files: [{ path: "out.txt", content: "😀".repeat(2_100_000), encoding: "utf8" }] };
  const failed = personalResultForTransfer("run", "claim", oversized);
  assert.equal(failed.status, "error"); assert.deepEqual(failed.files, []); assert.equal(failed.diff, "");
  assert.match(failed.summary, /No files or diff were uploaded/); assert.match(failed.summary, /not be executed again/);
  assert.equal(oversized.files[0].content.length, 4_200_000);
});
test("stages selected Codex auth only and returns no raw account or credentials", async (t) => {
  const { user, run } = await homes(t); await writeAuth(user); await writeAuth(user, "claude-code");
  const material = await stagePersonalAuth(run, user, "codex", now);
  assert.equal((await fs.stat(path.join(run, ".codex/auth.json"))).mode & 0o777, 0o400);
  await assert.rejects(fs.stat(path.join(run, ".claude")));
  const result = await inspectStagedPersonalAccount({ harness: "codex", homeDir: run, material, run: fakeStatus, now });
  assert.match(result.accountFingerprint, /^[a-f0-9]{64}$/); assert.match(result.authVersion, /^[a-f0-9]{64}$/);
  for (const forbidden of ["FAKE_REFRESH_SECRET", "account-one", "one@example.test", "access_token"]) assert.ok(!JSON.stringify(result).includes(forbidden));
});
test("Claude staging retains only nonsecret identity and disables all other cached settings", async (t) => {
  const { user, run } = await homes(t); await writeAuth(user, "claude-code"); await writeAuth(user);
  await fs.writeFile(path.join(user, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "one@example.test", organizationUuid: "org-one", injected: "secret" }, apiKeyHelper: "bad", mcpServers: { bad: {} } }));
  const material = await stagePersonalAuth(run, user, "claude-code", now);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(run, ".claude.json"))), { oauthAccount: { emailAddress: "one@example.test", organizationUuid: "org-one" } });
  await assert.rejects(fs.stat(path.join(run, ".codex")));
  const result = await inspectStagedPersonalAccount({ harness: "claude-code", homeDir: run, material, run: fakeStatus, now });
  assert.equal(result.probeMethod, "claude-auth-status");
});
test("rejects symlinked credential files, expired login, API-key login, and changed staged bytes", async (t) => {
  const { user, run, root } = await homes(t); await writeAuth(user);
  const filename = path.join(user, ".codex/auth.json"), original = await fs.readFile(filename);
  await fs.writeFile(path.join(root, "linked-auth"), original); await fs.unlink(filename); await fs.symlink(path.join(root, "linked-auth"), filename);
  await assert.rejects(stagePersonalAuth(run, user, "codex", now));
  await fs.unlink(filename); await writeAuth(user, "codex", { OPENAI_API_KEY: "FAKE_OTHER_API_KEY" });
  await assert.rejects(stagePersonalAuth(run, user, "codex", now));
  await writeAuth(user); const material = await stagePersonalAuth(run, user, "codex", now);
  const mutate = async (...args) => { const result = await fakeStatus(...args); if (args[1][0] === "app-server") { await fs.chmod(path.join(run, ".codex/auth.json"), 0o600); await fs.appendFile(path.join(run, ".codex/auth.json"), " "); } return result; };
  await assert.rejects(inspectStagedPersonalAccount({ harness: "codex", homeDir: run, material, run: mutate, now }));
  await assert.rejects(readPersonalAuthMaterial(user, "codex", now + 3600000));
});
test("never stages unrelated credential maps or unrecognized auth fields from a selected CLI file", async t => {
  const { user, run } = await homes(t);
  await writeAuth(user, "codex", { providerAccounts: { other: "OTHER_PROVIDER_SECRET" } });
  await assert.rejects(stagePersonalAuth(run, user, "codex", now));
  await assert.rejects(fs.stat(path.join(run, ".codex")));
  await writeAuth(user, "claude-code");
  const file = path.join(user, ".claude/.credentials.json"), original = JSON.parse(await fs.readFile(file, "utf8"));
  await fs.writeFile(file, JSON.stringify({ ...original, mcpOAuth: { privateVendor: "OTHER_MCP_SECRET" } }));
  await assert.rejects(stagePersonalAuth(run, user, "claude-code", now));
  await assert.rejects(fs.stat(path.join(run, ".claude")));
});
test("unsupported native probe identity, API-key fallback and old CLI fail unavailable", async (t) => {
  const { user } = await homes(t); await writeAuth(user);
  for (const run of [async () => ({ stdout: "codex-cli 0.1.0" }), async (...args) => args[1][0] === "--version" ? fakeStatus(...args) : { result: { requiresOpenaiAuth: false, account: { type: "apiKey" } } }]) await assert.rejects(probePersonalAccount({ harness: "codex", userHome: user, run, now }), /unavailable/);
});
test("project CLI configuration is explicitly unsupported", async (t) => {
  const { run } = await homes(t); await fs.mkdir(path.join(run, ".codex"));
  await assert.rejects(assertPersonalConfigurationSafe(run, "codex"), /configuration is unavailable/);
});
test("complete permission review is denied instead of redacted when auth or ambient secrets appear", async t => {
  const { user } = await homes(t); await writeAuth(user);
  const action = command => JSON.stringify({ version: 1, provider: "codex", method: "item/commandExecution/requestApproval", payload: { params: { command } } });
  assert.equal(await isSafePersonalApprovalReview(action("echo safe"), user, "codex", {}), true);
  for (const command of ["echo FAKE_REFRESH_SECRET", "echo account-one", "echo knownAmbientSecret987", '"password":"unknown"', "Bearer token-value", "x".repeat(2001)]) {
    assert.equal(await isSafePersonalApprovalReview(action(command), user, "codex", { PRIVATE_TOKEN: "knownAmbientSecret987" }), false, command);
  }
  assert.equal(await isSafePersonalApprovalReview(JSON.stringify({ version: 1, provider: "codex", method: "item/permissions/requestApproval", payload: {} }), user, "codex", {}), false);
  for (const tool_name of ["Agent", "Task", "mcp__other", "Unknown"]) assert.equal(await isSafePersonalApprovalReview(JSON.stringify({ version: 1, provider: "claude", method: "can_use_tool", payload: { request: { tool_name } } }), user, "claude-code", {}), false);
});
test("already-aborted auth subprocess never starts", async t => {
  const { root, run } = await homes(t), marker = path.join(root, "should-not-exist");
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runPersonalAuthCommand(process.execPath, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`], { signal: controller.signal, homeDir: run, env: personalChildEnvironment(run) }));
  await assert.rejects(fs.stat(marker));
});
test("non-inference subprocess uses refreshToken false and bounded JSON-RPC only", async (t) => {
  const { root, run } = await homes(t), script = path.join(root, "rpc.mjs");
  await fs.writeFile(script, `import readline from 'node:readline';const rl=readline.createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(m.id===1)console.log(JSON.stringify({id:1,result:{version:'fixture'}}));if(m.id===2)console.log(JSON.stringify({id:2,result:{noRefresh:m.params.refreshToken===false}}));});`);
  const result = await runPersonalAuthCommand(process.execPath, [script], { rpc: true, homeDir: run, env: personalChildEnvironment(run), timeoutMs: 1500 });
  assert.deepEqual(result.result, { noRefresh: true });
});
test("bounded subprocess rejects raw output, server auth requests, timeout and active abort without killing unrelated work", async (t) => {
  const { run } = await homes(t), options = { homeDir: run, env: personalChildEnvironment(run), timeoutMs: 100 };
  const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  t.after(() => unrelated.kill("SIGKILL"));
  for (const [code, rpc] of [["console.log('x'.repeat(70000))", false], ["console.log(JSON.stringify({id:9,method:'account/login'}));setInterval(()=>{},1000)", true], ["setInterval(()=>{},1000)", false]]) await assert.rejects(runPersonalAuthCommand(process.execPath, ["-e", code], { ...options, rpc }), /unavailable/);
  const controller = new AbortController(); const pending = runPersonalAuthCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], { ...options, timeoutMs: 5000, signal: controller.signal });
  controller.abort(); await assert.rejects(pending); assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
});
