// T69: owner-scoped, approval-hashed uploads; sandbox copies are re-hashed before use.
import { MAX_RUN_ATTACHMENT_BYTES, RUN_ATTACHMENT_NAME, type RunAttachment, type RunSignal } from "@shiba/shared";
import type { Env } from "./env.js";
import { scopedExec } from "./exec-allowlist.js";
import type { SandboxOps } from "./runtime.js";
import { shellJoin } from "./security.js";

export const ATTACHMENT_DIR = ".shiba/attachments";
const GIT_ALLOWLIST: readonly (readonly string[])[] = [["git"]];
const SUM_ALLOWLIST: readonly (readonly string[])[] = [["sha256sum"]];

const objectKey = (owner: string, sha256: string) => `run-attachments/${owner}/${sha256}`;
const hex = (bytes: ArrayBuffer | undefined) =>
  bytes === undefined ? "" : Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

/** A bare, safe file name from whatever the browser sent. */
export function attachmentName(raw: string): string {
  const base = (raw.split(/[\\/]/).pop() ?? "").replace(/[^A-Za-z0-9._ ()-]/g, "_").trim();
  const name = (/^[A-Za-z0-9]/.test(base) ? base : `file-${base}`).slice(0, 120);
  if (!RUN_ATTACHMENT_NAME.test(name)) throw new Error("That file name can't be used.");
  return name;
}

/** Stores one upload. Throws a user-facing message. */
export async function storeRunAttachment(
  env: Pick<Env, "ATTACHMENTS">,
  owner: string,
  rawName: string,
  request: Request,
): Promise<RunAttachment> {
  // Without a declared length the body would be buffered before the cap could apply.
  const declared = Number(request.headers.get("content-length") ?? Number.NaN);
  if (!Number.isInteger(declared) || declared < 0) throw new Error("Content-Length is required.");
  if (declared > MAX_RUN_ATTACHMENT_BYTES) throw new Error(`A file can be at most ${MAX_RUN_ATTACHMENT_BYTES} bytes.`);
  const name = attachmentName(rawName);
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  if (reader !== undefined) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > declared || received > MAX_RUN_ATTACHMENT_BYTES) {
          await reader.cancel();
          throw new Error("The upload exceeds its declared length or the file size limit.");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  if (received !== declared) throw new Error("The upload was cut short.");
  const bytes = new ArrayBuffer(received);
  const view = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    view.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const sha256 = hex(await crypto.subtle.digest("SHA-256", bytes));
  // R2 rejects the put if the body doesn't hash to this.
  await env.ATTACHMENTS.put(objectKey(owner, sha256), bytes, { sha256 });
  return { name, sha256, size: bytes.byteLength };
}

/** Intake: every listed file must already be stored under this owner. */
export async function verifyRunAttachments(
  env: Pick<Env, "ATTACHMENTS">,
  owner: string,
  attachments: readonly RunAttachment[],
): Promise<void> {
  for (const attachment of attachments) {
    const head = await env.ATTACHMENTS.head(objectKey(owner, attachment.sha256));
    if (head === null || head.size !== attachment.size || hex(head.checksums.sha256) !== attachment.sha256) {
      throw new Error(`Attachment ${attachment.name} isn't uploaded; attach it again.`);
    }
  }
}

export async function openRunAttachment(
  env: Pick<Env, "ATTACHMENTS">,
  owner: string,
  attachment: RunAttachment,
): Promise<ReadableStream<Uint8Array>> {
  const object = await env.ATTACHMENTS.get(objectKey(owner, attachment.sha256));
  if (object === null) throw new Error(`Attachment ${attachment.name} is no longer stored.`);
  if (object.size !== attachment.size || hex(object.checksums.sha256) !== attachment.sha256) {
    await object.body.cancel();
    throw new Error(`Attachment ${attachment.name} doesn't match what was approved.`);
  }
  return object.body;
}

/** Tells the harness where the files are; the approved task text itself is unchanged. */
export function withAttachmentNote<T extends { task: string; attachments?: RunAttachment[] }>(input: T): T {
  if (!input.attachments?.length) return input;
  const list = input.attachments.map((a) => `- ${ATTACHMENT_DIR}/${a.name} (${a.size} bytes)`).join("\n");
  return { ...input, task: `${input.task}\n\nThe user attached these files. They aren't part of the repository:\n${list}` };
}

/** Copies the approved files into the clone, hidden from git, and re-hashes them on disk. Returns a failure or null. */
export async function placeRunAttachments(
  ops: SandboxOps,
  workdir: string,
  attachments: readonly RunAttachment[],
  open: (attachment: RunAttachment) => Promise<ReadableStream<Uint8Array>>,
  opts: { signals: RunSignal[]; signal?: AbortSignal },
): Promise<string | null> {
  const writeStream = ops.writeFileStream;
  if (writeStream === undefined) return "This sandbox provider can't take attachments yet.";
  const exec = (argv: string[], allowlist: readonly (readonly string[])[]) =>
    scopedExec(ops, shellJoin(argv), { cwd: workdir, allowlist, signals: opts.signals, signal: opts.signal, timeoutMs: 120_000 });
  // A tracked file there would be overwritten and then published as the agent's change.
  const tracked = await exec(["git", "ls-files", "-z", "--", ATTACHMENT_DIR], GIT_ALLOWLIST);
  if (tracked.exitCode !== 0) return `Could not check ${ATTACHMENT_DIR} (git exit ${tracked.exitCode}).`;
  if (tracked.stdout !== "") return `The repository already tracks files in ${ATTACHMENT_DIR}/, so attachments can't be placed there.`;
  // Reject symlink ancestors and destinations before writing any attachment or git metadata.
  const destinations = [".shiba", ATTACHMENT_DIR, ".git", ".git/info", ".git/info/exclude", ...attachments.map((a) => `${ATTACHMENT_DIR}/${a.name}`)];
  for (const path of destinations) {
    const check = await exec(["test", "-L", path], [["test"]]);
    if (check.exitCode === 0) return `Attachments can't use symlink path ${path}.`;
    if (check.exitCode !== 1) return `Could not check attachment path ${path}.`;
  }
  // Excluded, so status, checkpoints, the setup commit and the PR never pick them up.
  const exclude = `${workdir}/.git/info/exclude`;
  const current = await ops.readFile(exclude, { maxBytes: 64_000, signal: opts.signal }).catch(() => null);
  await ops.writeFile(exclude, `${current?.kind === "utf8" ? current.content : ""}\n/${ATTACHMENT_DIR}/\n`);
  for (const attachment of attachments) {
    await writeStream.call(ops, `${workdir}/${ATTACHMENT_DIR}/${attachment.name}`, await open(attachment));
  }
  const paths = attachments.map((a) => `${ATTACHMENT_DIR}/${a.name}`);
  const sums = await exec(["sha256sum", "--", ...paths], SUM_ALLOWLIST);
  if (sums.exitCode !== 0) return `Could not hash the attachments in the sandbox (exit ${sums.exitCode}).`;
  // `<64 hex>  <path>` per line; names can't hold a newline or backslash, so no escaping.
  const onDisk = new Map(sums.stdout.split("\n").filter(Boolean).map((line) => [line.slice(66), line.slice(0, 64)]));
  const wrong = attachments.find((a, i) => onDisk.get(paths[i] as string) !== a.sha256);
  return wrong === undefined ? null : `Attachment ${wrong.name} doesn't match what was approved after copying.`;
}
