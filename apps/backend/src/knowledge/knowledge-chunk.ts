/** Token-oriented chunking (~800 tokens, 100 overlap) using a 4-char/token estimate. */
const CHUNK_CHARS = 800 * 4;
const OVERLAP_CHARS = 100 * 4;

export function chunkText(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    const end = Math.min(normalized.length, start + CHUNK_CHARS);
    chunks.push(normalized.slice(start, end));
    if (end >= normalized.length) break;
    start = Math.max(0, end - OVERLAP_CHARS);
    if (start === 0 && end === normalized.length) break;
  }
  return chunks;
}