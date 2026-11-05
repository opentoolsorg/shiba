import { createHash } from "node:crypto";
import { Zip, ZipPassThrough } from "fflate";

const CHUNK_BYTES = 65_536;

interface ArchiveEntry {
  name: string;
  bytes: Uint8Array<ArrayBuffer>;
}

/** ZIP store output keeps only one data chunk and the bounded directory in flight. */
function* archiveChunks(entries: readonly ArchiveEntry[]): Generator<Uint8Array<ArrayBuffer>> {
  const pending: Uint8Array<ArrayBuffer>[] = [];
  const zip = new Zip((error, chunk) => {
    if (error) throw error;
    if (chunk.byteLength) pending.push(chunk);
  });
  try {
    for (const entry of entries) {
      const file = new ZipPassThrough(entry.name);
      file.mtime = new Date(1980, 0, 1, 0, 0, 0);
      zip.add(file);
      if (entry.bytes.byteLength === 0) file.push(new Uint8Array(), true);
      for (let offset = 0; offset < entry.bytes.byteLength; offset += CHUNK_BYTES) {
        file.push(entry.bytes.subarray(offset, offset + CHUNK_BYTES), offset + CHUNK_BYTES >= entry.bytes.byteLength);
        yield* pending.splice(0);
      }
      yield* pending.splice(0);
    }
    zip.end();
    yield* pending.splice(0);
  } finally {
    zip.terminate();
  }
}

/** Entries belong to the capture boundary and are never returned to a caller. */
export function prepareWorkspaceArchive(entries: readonly ArchiveEntry[], maxBytes: number) {
  const hash = createHash("sha256");
  let byteLength = 0;
  for (const chunk of archiveChunks(entries)) {
    byteLength += chunk.byteLength;
    if (byteLength > maxBytes) throw new Error("Workspace archive exceeds its size limit.");
    hash.update(chunk);
  }
  return {
    byteLength,
    sha256: hash.digest("hex"),
    fileCount: entries.length,
    chunks: () => archiveChunks(entries),
    async writeTo(writable: WritableStream<Uint8Array>, signal: AbortSignal) {
      const writer = writable.getWriter();
      // Abort the writer directly so a blocked write does not wait for another read.
      const abort = () => { void writer.abort(signal.reason).catch(() => {}); };
      signal.addEventListener("abort", abort, { once: true });
      try {
        signal.throwIfAborted();
        for (const chunk of archiveChunks(entries)) {
          signal.throwIfAborted();
          await writer.write(chunk);
        }
        await writer.close();
      } catch (error) {
        await writer.abort(error).catch(() => {});
        throw error;
      } finally {
        signal.removeEventListener("abort", abort);
        writer.releaseLock();
      }
    },
  };
}
