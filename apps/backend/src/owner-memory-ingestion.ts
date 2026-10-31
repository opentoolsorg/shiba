import { InputError } from "./security.js";

export const MAX_MEMORY_UPLOAD_BYTES = 40_000;

export async function memoryContentHash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

export function validateMemoryText(bytes: Uint8Array): string {
  if (!bytes.length || bytes.length > MAX_MEMORY_UPLOAD_BYTES) throw new InputError("Text files must contain 1–40000 bytes.");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new InputError("Only valid UTF-8 text files are supported."); }
  const hasControl = Array.from(text).some((char) => {
    const code = char.charCodeAt(0);
    return (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127;
  });
  if (!text.trim() || hasControl ||
      /^(?:%PDF-|PK|MZ|GIF8|\{\\rtf\d)/i.test(text.trimStart()) ||
      /<\s*(?:!doctype|!--|\/?[a-z][\w:-]*)(?:\s|>|\/)/i.test(text)) {
    throw new InputError("Only plain TXT or Markdown without binary content or active markup is supported. PDF, Office, archives, HTML and SVG are unsupported.");
  }
  return text.replace(/\r\n/g, "\n");
}

/** Bounds the stream itself; Content-Length is only an additional consistency check. */
export async function readMemoryUpload(request: Request) {
  const filename = request.headers.get("x-source-filename") ?? "";
  const mediaType = (request.headers.get("content-type") ?? "").toLowerCase();
  const match = /^(text\/plain|text\/markdown)(?:;\s*charset=utf-8)?$/.exec(mediaType);
  const acceptedMediaType = match?.[1];
  if (!/^[a-z0-9][a-z0-9 ._-]{0,179}\.(?:txt|md)$/i.test(filename) || !acceptedMediaType ||
      (filename.toLowerCase().endsWith(".txt") ? acceptedMediaType !== "text/plain" : acceptedMediaType !== "text/markdown")) {
    throw new InputError("Upload a .txt file as text/plain or .md as text/markdown; filenames must be simple basenames.");
  }
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_MEMORY_UPLOAD_BYTES)) throw new InputError("Text files must contain at most 40000 bytes.");
  const reader = request.body?.getReader();
  if (!reader) throw new InputError("Upload body is required.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_MEMORY_UPLOAD_BYTES) throw new InputError("Text files must contain at most 40000 bytes.");
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error instanceof InputError ? error : new InputError("Upload was interrupted. Retry the complete file.");
  }
  if (declared !== null && Number(declared) !== length) throw new InputError("Upload length did not match Content-Length. Retry the complete file.");
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return { filename, mediaType: acceptedMediaType, bytes, content: validateMemoryText(bytes), sha256: await memoryContentHash(bytes) };
}
