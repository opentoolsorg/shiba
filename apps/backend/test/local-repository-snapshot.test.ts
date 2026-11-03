import { execFile } from "node:child_process";
import { link, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
type Git = (args: string[], maxBytes?: number) => Promise<Buffer>;
const gitCommand = (args: string[]) => args[0] === "--no-replace-objects" ? args.slice(1) : args;
interface Snapshot { changedFiles: string[]; diff: string; files: Array<{ path: string; content: string | null; encoding: "utf8" | "base64" }> }
const { collectLocalRepositorySnapshot } = await import(new URL("../../../scripts/local-repository-snapshot.mjs", import.meta.url).href) as {
  collectLocalRepositorySnapshot(input: { cloneDir: string; baseRevision: string; expectedDeliverables?: string[]; git: Git }): Promise<Snapshot>;
};
let root: string;
let baseRevision: string;
let git: Git;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "shiba-local-snapshot-"));
  git = async (args, maxBytes = 1_000_000) => (await exec("git", ["-C", root, ...args], { encoding: "buffer", maxBuffer: Math.max(1, maxBytes + 1) })).stdout;
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Snapshot test"]);
  await git(["config", "user.email", "snapshot@example.com"]);
  await writeFile(path.join(root, "README.md"), "original base\n");
  await writeFile(path.join(root, "deleted.txt"), "original deletion\n");
  await git(["add", "-A"]);
  await git(["commit", "-m", "base"]);
  baseRevision = new TextDecoder().decode(await git(["rev-parse", "HEAD"])).trim();
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("local immutable repository capture", () => {
  it("counts unchanged requested deliverables toward the complete 50-file limit", async () => {
    for (let index = 0; index < 50; index++) await writeFile(path.join(root, `file-${index}.txt`), "complete output\n");
    await expect(collectLocalRepositorySnapshot({ cloneDir: root, baseRevision, expectedDeliverables: ["README.md"], git })).rejects.toThrow(/50-file limit/);
    expect((await git(["diff", "--cached", "--name-only"])).toString()).toBe("");
  });

  it("rechecks the frozen manifest when a 51st path appears during staging", async () => {
    for (let index = 0; index < 50; index++) await writeFile(path.join(root, `file-${index}.txt`), "complete output\n");
    await expect(collectLocalRepositorySnapshot({ cloneDir: root, baseRevision, git: async (args, maxBytes) => {
      if (gitCommand(args)[0] === "add") await writeFile(path.join(root, "file-51.txt"), "late output\n");
      return git(args, maxBytes);
    } })).rejects.toThrow(/checkpoint exceeds the 50-file limit/);
  });

  it("includes harness commits and freezes text, binary, empty files, and deletions despite later HEAD/index/worktree changes", async () => {
    await writeFile(path.join(root, "README.md"), "committed harness work\n");
    await git(["add", "README.md"]);
    await git(["commit", "-m", "harness commit"]);
    const binary = Buffer.from([0, 255, 1, 2, 128]);
    await writeFile(path.join(root, "image.bin"), binary);
    await writeFile(path.join(root, "empty.txt"), "");
    await rm(path.join(root, "deleted.txt"));
    const result = await collectLocalRepositorySnapshot({ cloneDir: root, baseRevision, git: async (args, maxBytes) => {
      const output = await git(args, maxBytes);
      if (gitCommand(args)[0] === "write-tree") {
        await writeFile(path.join(root, "README.md"), "later unapproved work\n");
        await writeFile(path.join(root, "image.bin"), "later bytes");
        await git(["add", "-A"]);
        await git(["commit", "-m", "move head after checkpoint"]);
      }
      return output;
    } });
    expect(result.changedFiles).toEqual(["README.md", "deleted.txt", "empty.txt", "image.bin"]);
    expect(result.files).toEqual([
      { path: "README.md", content: "committed harness work\n", encoding: "utf8" },
      { path: "deleted.txt", content: null, encoding: "utf8" },
      { path: "empty.txt", content: "", encoding: "utf8" },
      { path: "image.bin", content: binary.toString("base64"), encoding: "base64" },
    ]);
    expect(result.diff).toContain("+committed harness work");
    expect(result.diff).not.toContain("later unapproved");
    expect(await readFile(path.join(root, "README.md"), "utf8")).toBe("later unapproved work\n");
  });

  it("reads requested deliverables from the same immutable tree", async () => {
    await writeFile(path.join(root, "brief.md"), "# Approved settled brief\n");
    const result = await collectLocalRepositorySnapshot({ cloneDir: root, baseRevision, expectedDeliverables: ["brief.md"], git: async (args, maxBytes) => {
      const output = await git(args, maxBytes);
      if (gitCommand(args)[0] === "write-tree") await writeFile(path.join(root, "brief.md"), "later mutable brief\n");
      return output;
    } });
    expect(result.files[0]).toEqual({ path: "brief.md", content: "# Approved settled brief\n", encoding: "utf8" });
  });

  it.each(["truncated", "corrupt"])("rejects %s immutable blob transport", async (mode) => {
    await writeFile(path.join(root, "README.md"), "complete frozen content\n");
    await expect(collectLocalRepositorySnapshot({ cloneDir: root, baseRevision, git: async (args, maxBytes) => {
      const output = await git(args, maxBytes);
      return gitCommand(args)[0] === "cat-file" && gitCommand(args)[1] === "blob"
        ? mode === "truncated" ? output.subarray(0, output.length - 1) : Buffer.alloc(output.length, 120)
        : output;
    } })).rejects.toThrow(/truncated or corrupt/);
  });

  it.each(["symlink", "hardlink"])("preserves %s rejection before staging", async (mode) => {
    const outside = path.join(root, "..", `${path.basename(root)}-outside.txt`);
    try {
      await writeFile(outside, "outside approved repository\n");
      if (mode === "symlink") await symlink(outside, path.join(root, "linked.txt"));
      else await link(outside, path.join(root, "linked.txt"));
      await expect(collectLocalRepositorySnapshot({ cloneDir: root, baseRevision, git })).rejects.toThrow(/symlink|hard-linked/);
      expect((await git(["diff", "--cached", "--name-only"])).toString()).toBe("");
    } finally { await rm(outside, { force: true }); }
  });

  it("rejects a symlink committed by the harness", async () => {
    await symlink("README.md", path.join(root, "linked.txt"));
    await git(["add", "linked.txt"]);
    await git(["commit", "-m", "unsafe harness commit"]);
    await expect(collectLocalRepositorySnapshot({ cloneDir: root, baseRevision, git })).rejects.toThrow(/symlink/);
  });

  it("rejects a file changed to a symlink between worktree validation and staging", async () => {
    await writeFile(path.join(root, "README.md"), "initially regular content\n");
    await expect(collectLocalRepositorySnapshot({ cloneDir: root, baseRevision, git: async (args, maxBytes) => {
      if (gitCommand(args)[0] === "add") {
        await rm(path.join(root, "README.md"));
        await symlink("deleted.txt", path.join(root, "README.md"));
      }
      return git(args, maxBytes);
    } })).rejects.toThrow(/unsupported .*type/);
  });

  it.each([false, true])("ignores a valid replacement tree introduced after freezing (requested=%s)", async (requested) => {
    await writeFile(path.join(root, "README.md"), "original frozen bytes\n");
    const result = await collectLocalRepositorySnapshot({ cloneDir: root, baseRevision,
      ...(requested ? { expectedDeliverables: ["README.md"] } : {}),
      git: async (args, maxBytes) => {
        expect(args[0]).toBe("--no-replace-objects");
        const output = await git(args, maxBytes);
        if (gitCommand(args)[0] === "write-tree") {
          const originalTree = new TextDecoder().decode(output).trim();
          await writeFile(path.join(root, "README.md"), "replacement tree bytes\n");
          await git(["add", "-A"]);
          const replacementTree = new TextDecoder().decode(await git(["write-tree"])).trim();
          await git(["replace", originalTree, replacementTree]);
          // Prove this real replacement redirects a normal fixed-OID read.
          expect(new TextDecoder().decode(await git(["show", `${originalTree}:README.md`]))).toBe("replacement tree bytes\n");
        }
        return output;
      },
    });
    expect(result.changedFiles).toEqual(["README.md"]);
    expect(result.files).toEqual([{ path: "README.md", content: "original frozen bytes\n", encoding: "utf8" }]);
    expect(result.diff).toContain("+original frozen bytes");
    expect(result.diff).not.toContain("replacement tree bytes");
  });
});
