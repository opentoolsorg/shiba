import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scopedExec, tokenizeCommand } from "../src/exec-allowlist.js";
import { captureCheckpoint } from "../src/git-checkpoint.js";
import { OpenCodeHarness } from "../src/harness/opencode.js";
import { formatAgentResult, parseAgentResult, type CodingTaskInput } from "../src/opencode-input.js";
import { collectRepositoryChanges, collectExpectedSandboxDeliverables, collectWorkspaceChanges, REPOSITORY_BLOB_READER, REPOSITORY_MANIFEST_READER, SandboxRuntimeAdapter, type SandboxOps } from "../src/runtime.js";

const directories: string[] = [];
afterEach(() => { for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "shiba-repository-snapshot-"));
  directories.push(root);
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(root, "draft.txt"), "initial draft\n");
  writeFileSync(join(root, "deleted.txt"), "initial deleted\n");
  git("add", "-A");
  git("-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-q", "-m", "base");
  const baseRevision = git("rev-parse", "HEAD");
  const ops: SandboxOps = {
    async gitCheckout() {},
    async writeFile(path, content) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); },
    async readFile() { throw new Error("Repository publication must never read the mutable filesystem."); },
    async exec(command, options) {
      const argv = tokenizeCommand(command);
      if (!argv?.length) throw new Error("Malformed test command");
      const stdout = execFileSync(argv[0]!, argv.slice(1), {
        cwd: options?.cwd ?? root, env: { ...process.env, ...options?.env },
        encoding: "utf8", maxBuffer: 25_000_000,
      });
      return { stdout, stderr: "", exitCode: 0 };
    },
  };
  return { root, git, ops, baseRevision };
}
class TestHarness extends OpenCodeHarness {
  override buildArgv() { return ["test-harness"]; }
}

describe("repository publication snapshot", { timeout: 30_000 }, () => {
  it("captures settled text, empty and binary bytes and deletions despite later worktree/ref/HEAD mutations", async () => {
    const { root, ops, git, baseRevision } = fixture();
    const baseline = await captureCheckpoint(ops, root, "immutable", 0);
    writeFileSync(join(root, "draft.txt"), "settled draft\n");
    writeFileSync(join(root, "data.bin"), Buffer.from([0, 255, 10]));
    writeFileSync(join(root, "empty.txt"), "");
    writeFileSync(join(root, "a space → café.txt"), "settled Unicode\n");
    rmSync(join(root, "deleted.txt"));
    const settled = await captureCheckpoint(ops, root, "immutable", 1);
    rmSync(join(root, "draft.txt"));
    symlinkSync("/etc/passwd", join(root, "draft.txt"));
    writeFileSync(join(root, "data.bin"), "late replacement");
    writeFileSync(join(root, "deleted.txt"), "late recreation");
    writeFileSync(join(root, "late.txt"), "must not enter publication");
    git("update-ref", "refs/shiba/checkpoints/immutable/0", baseRevision);
    git("update-ref", "refs/shiba/checkpoints/immutable/1", baseRevision);
    git("update-ref", "HEAD", baseline);
    const result = await collectRepositoryChanges(ops, root, baseline, settled);
    expect(result.files).toEqual([
      { path: "a space → café.txt", content: "settled Unicode\n", encoding: "utf8" },
      { path: "data.bin", content: "AP8K", encoding: "base64" },
      { path: "draft.txt", content: "settled draft\n", encoding: "utf8" },
      { path: "empty.txt", content: "", encoding: "utf8" },
      { path: "deleted.txt", content: null, encoding: "utf8" },
    ]);
    expect(result.changedFiles).toEqual(["a space → café.txt", "data.bin", "deleted.txt", "draft.txt", "empty.txt"]);
    expect(result.diff).toContain("+settled draft");
    expect(result.diff).not.toContain("late replacement");
  });

  it("wires actual settled OIDs and pre-harness clone revision through the adapter and result envelope", async () => {
    const { root, ops, git, baseRevision } = fixture();
    const execute = ops.exec.bind(ops);
    const adapterOps: SandboxOps = { ...ops, async writeFile() {}, async exec(command, options) {
      if (command === "'test-harness'") {
        writeFileSync(join(root, "draft.txt"), "settled adapter draft\n");
        git("add", "-A");
        git("-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-q", "-m", "harness moved HEAD");
        return { stdout: "done", stderr: "", exitCode: 0 };
      }
      const result = await execute(command, { ...options, cwd: root });
      if (command.includes("'update-ref'") && command.includes("/1'")) {
        writeFileSync(join(root, "draft.txt"), "late mutable body\n");
        writeFileSync(join(root, "late.txt"), "late file");
        git("update-ref", "refs/shiba/checkpoints/snapshot/0", baseRevision);
        git("update-ref", "refs/shiba/checkpoints/snapshot/1", baseRevision);
      }
      return result;
    } };
    const input: CodingTaskInput = { repoUrl: "https://github.com/org/repo", baseBranch: "main", sandboxId: "snapshot", task: "Update draft", codingModel: "google/gemini-3.5-flash-lite", publishPullRequest: false, expectedDeliverables: ["draft.txt"] };
    const result = await new SandboxRuntimeAdapter(new TestHarness()).runCodingTask(adapterOps, input, () => {});
    expect(result).toMatchObject({ status: "completed", baseRevision, changedFiles: ["draft.txt"], files: [{ path: "draft.txt", content: "settled adapter draft\n", encoding: "utf8" }] });
    expect(parseAgentResult(formatAgentResult(result))?.baseRevision).toBe(baseRevision);
    expect(result.diff).toContain("+settled adapter draft");
    expect(result.diff).not.toContain("late mutable body");
  });

  it.each(["", "main", "a".repeat(64), "transport failure"])("fails before the harness when cloned GitHub revision is invalid: %j", async (revision) => {
    const { ops } = fixture();
    const execute = ops.exec.bind(ops);
    let harnessStarted = false;
    const guarded: SandboxOps = { ...ops, async writeFile() {}, async exec(command, options) {
      if (command.includes("HEAD^{commit}")) {
        if (revision === "transport failure") throw new Error("base transport failed");
        return { stdout: revision, stderr: "", exitCode: 0 };
      }
      if (command === "'test-harness'") harnessStarted = true;
      return execute(command, options);
    } };
    const result = await new SandboxRuntimeAdapter(new TestHarness()).runCodingTask(guarded, {
      repoUrl: "https://github.com/org/repo", baseBranch: "main", sandboxId: "bad-base", task: "Fix it",
      codingModel: "google/gemini-3.5-flash-lite", publishPullRequest: false,
    }, () => {});
    expect(result.status).toBe("error");
    expect(result.summary).toContain("base revision");
    expect(harnessStarted).toBe(false);
  });

  it("retains a complete maximum-size blob beyond the default scoped exec cap", async () => {
    const { root, ops } = fixture();
    const baseline = await captureCheckpoint(ops, root, "large", 0);
    const content = "é".repeat(50_000);
    writeFileSync(join(root, "draft.txt"), content);
    const settled = await captureCheckpoint(ops, root, "large", 1);
    const scoped: SandboxOps = { ...ops, exec: (command, options) => scopedExec(ops, command, {
      ...options, allowlist: [["git"], ["node", "-e", REPOSITORY_MANIFEST_READER], ["node", "-e", REPOSITORY_BLOB_READER]],
    }) };
    const result = await collectRepositoryChanges(scoped, root, baseline, settled);
    expect(result.files).toEqual([{ path: "draft.txt", content, encoding: "utf8" }]);
  });

  it("preserves renames as an immutable new blob and deletion of the original path", async () => {
    const { root, ops, git } = fixture();
    const baseline = await captureCheckpoint(ops, root, "rename", 0);
    git("mv", "draft.txt", "renamed.txt");
    const settled = await captureCheckpoint(ops, root, "rename", 1);
    const result = await collectRepositoryChanges(ops, root, baseline, settled);
    expect(result.changedFiles).toEqual(["draft.txt", "renamed.txt"]);
    expect(result.files).toEqual([
      { path: "renamed.txt", content: "initial draft\n", encoding: "utf8" },
      { path: "draft.txt", content: null, encoding: "utf8" },
    ]);
  });

  it.each(["settled commit", "baseline commit", "tree", "blob"])("ignores post-checkpoint Git replacement refs for %s in repository, required-output, and workspace capture", async (kind) => {
    const { root, ops, git, baseRevision } = fixture();
    mkdirSync(join(root, "out"));
    writeFileSync(join(root, "out/report.txt"), "baseline report\n");
    const baseline = await captureCheckpoint(ops, root, "replacement", 0);
    writeFileSync(join(root, "draft.txt"), "settled draft\n");
    writeFileSync(join(root, "out/report.txt"), "settled report\n");
    const settled = await captureCheckpoint(ops, root, "replacement", 1);
    const before = await collectRepositoryChanges(ops, root, baseline, settled);
    writeFileSync(join(root, "draft.txt"), "replacement draft\n");
    writeFileSync(join(root, "out/report.txt"), "replacement report\n");
    git("add", "-A");
    const replacementTree = git("write-tree");
    const replacementCommit = git("-c", "user.name=Test", "-c", "user.email=test@example.test", "commit-tree", replacementTree, "-p", baseRevision, "-m", "replacement");
    const original = kind === "baseline commit" ? baseline : kind === "settled commit" ? settled : kind === "tree" ? git("rev-parse", `${settled}^{tree}`) : git("rev-parse", `${settled}:draft.txt`);
    const replacement = kind === "tree" ? replacementTree : kind === "blob" ? git("rev-parse", `${replacementCommit}:draft.txt`) : replacementCommit;
    git("replace", original, replacement);
    // Establish that ordinary Git reads actually follow the installed replacement.
    expect(git("show", `${kind === "baseline commit" ? baseline : settled}:draft.txt`)).toBe("replacement draft");
    expect(await collectRepositoryChanges(ops, root, baseline, settled)).toEqual(before);
    expect(await collectExpectedSandboxDeliverables(ops, root, settled, ["draft.txt"])).toEqual([
      { path: "draft.txt", content: "settled draft\n", encoding: "utf8" },
    ]);
    expect((await collectWorkspaceChanges(ops, root, settled)).files).toEqual([
      { path: "out/report.txt", content: "settled report\n", encoding: "utf8" },
    ]);
  });

  it("rejects a settled symlink rather than reading its target", async () => {
    const { root, ops } = fixture();
    const baseline = await captureCheckpoint(ops, root, "symlink", 0);
    symlinkSync("/etc/passwd", join(root, "linked.txt"));
    const settled = await captureCheckpoint(ops, root, "symlink", 1);
    await expect(collectRepositoryChanges(ops, root, baseline, settled)).rejects.toThrow(/symlink|unsupported/);
  });

  it("rejects incomplete or substituted bytes despite unchanged transport length", async () => {
    const { root, ops } = fixture();
    const baseline = await captureCheckpoint(ops, root, "corrupt", 0);
    writeFileSync(join(root, "draft.txt"), "settled draft\n");
    const settled = await captureCheckpoint(ops, root, "corrupt", 1);
    const execute = ops.exec.bind(ops);
    for (const replacement of ["", Buffer.from("corrupt draft\n").toString("base64")]) {
      const corrupted = { ...ops, async exec(command: string, options?: Parameters<SandboxOps["exec"]>[1]) {
        const result = await execute(command, options);
        return tokenizeCommand(command)?.[2] === REPOSITORY_BLOB_READER ? { ...result, stdout: replacement } : result;
      } };
      await expect(collectRepositoryChanges(corrupted, root, baseline, settled)).rejects.toThrow(/truncated|corrupt/);
    }
  });
});
