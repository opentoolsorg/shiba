/** Git-object transport fixture for adapter unit tests. Real Git integration
 * and post-checkpoint mutation coverage live in repository-snapshot.test.ts. */
import { createHash } from "node:crypto";
import { tokenizeCommand } from "../src/exec-allowlist.js";
import { REPOSITORY_MANIFEST_READER, REPOSITORY_BLOB_READER, DELIVERABLE_BLOB_READER, unescapePorcelainPath, type ExecResult } from "../src/runtime.js";

export const FIXTURE_BASE_REVISION = "a".repeat(40);
export const FIXTURE_BASELINE_COMMIT = "b".repeat(40);
export const FIXTURE_SETTLED_COMMIT = "c".repeat(40);

export function repositorySnapshotFixture(options: {
  status?: string | (() => string);
  files?: Record<string, string | Uint8Array>;
} = {}) {
  let checkpoints = 0;
  const blobs = new Map<string, Uint8Array>();
  const blob = (path: string) => {
    const value = options.files?.[path] ?? "x";
    const bytes = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
    const objectId = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    blobs.set(objectId, bytes);
    return objectId;
  };
  const ok = (stdout: string): ExecResult => ({ stdout, stderr: "", exitCode: 0 });
  return async (command: string): Promise<ExecResult | undefined> => {
    const argv = tokenizeCommand(command);
    if (!argv) return undefined;
    if (argv[0] === "git" && argv[1] === "--no-replace-objects") argv.splice(1, 1);
    if (argv[0] === "git") {
      if (argv[1] === "rev-parse" && argv.includes("HEAD^{commit}")) return ok(`${FIXTURE_BASE_REVISION}\n`);
      if (argv[1] === "rev-parse" && argv.includes("--git-dir")) return ok(".git\n");
      if (argv[1] === "write-tree") return ok(`${"d".repeat(40)}\n`);
      if (argv[1] === "commit-tree") return ok(`${checkpoints++ === 0 ? FIXTURE_BASELINE_COMMIT : FIXTURE_SETTLED_COMMIT}\n`);
      if (argv[1] === "cat-file" && argv[2] === "-s") {
        const bytes = blobs.get(argv[3]!);
        if (!bytes) throw new Error(`Unknown fixture blob: ${argv[3]}`);
        return ok(`${bytes.length}\n`);
      }
      if (argv[1] === "ls-tree" && argv.includes("-z")) {
        const path = argv.at(-1)!;
        return ok(`100644 blob ${blob(path)}\t${path}\0`);
      }
      return undefined;
    }
    if (argv[0] !== "node" || argv[1] !== "-e") return undefined;
    if (argv[2] === REPOSITORY_MANIFEST_READER) {
      const status = typeof options.status === "function" ? options.status() : options.status ?? " M a.ts\n";
      const changes: Array<{ path: string; kind: "A" | "M" | "D" }> = [];
      for (const line of status.split("\n")) {
        if (line.length < 4) continue;
        const flags = line.slice(0, 2);
        const rest = line.slice(3);
        const arrow = rest.indexOf(" -> ");
        if (flags.includes("R") && arrow >= 0) {
          changes.push({ path: unescapePorcelainPath(rest.slice(0, arrow)), kind: "D" });
          changes.push({ path: unescapePorcelainPath(rest.slice(arrow + 4)), kind: "A" });
        } else {
          changes.push({ path: unescapePorcelainPath(rest), kind: flags.includes("D") ? "D" : flags.includes("?") || flags.includes("A") ? "A" : "M" });
        }
      }
      const manifest = changes.map(({ path, kind }) => `:${kind === "A" ? "000000" : "100644"} ${kind === "D" ? "000000" : "100644"} ${kind === "A" ? "0".repeat(40) : FIXTURE_BASE_REVISION} ${kind === "D" ? "0".repeat(40) : blob(path)} ${kind}\0${path}\0`).join("");
      return ok(JSON.stringify({ changes: Buffer.from(manifest).toString("base64") }));
    }
    if (argv[2] === REPOSITORY_BLOB_READER || argv[2] === DELIVERABLE_BLOB_READER) {
      const bytes = blobs.get(argv[3]!);
      if (!bytes) throw new Error(`Unknown fixture blob: ${argv[3]}`);
      return ok(Buffer.from(bytes).toString("base64"));
    }
    return undefined;
  };
}
