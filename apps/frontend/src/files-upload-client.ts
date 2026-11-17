import type { KnowledgeScope } from "@shiba/shared";

type UploadResponse = {
  error?: unknown;
  session?: { sessionId?: unknown; partSize?: unknown };
  part?: { partNumber?: unknown; etag?: unknown };
};

async function postUpload(url: string, body: BodyInit, contentType: string): Promise<UploadResponse> {
  const response = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": contentType },
    body,
  });
  const result = await response.json().catch(() => null) as UploadResponse | null;
  if (!response.ok) {
    throw new Error(typeof result?.error === "string" ? result.error : response.status === 429
      ? "Upload rate limit exceeded."
      : `Upload failed (${response.status}).`);
  }
  return result ?? {};
}

export async function uploadFile(file: File, options: {
  scope: KnowledgeScope;
  folderId: string | null;
  onProgress?: (partsDone: number, totalParts: number) => void;
}): Promise<void> {
  const url = `/api/files/uploads?${new URLSearchParams({ scope: options.scope })}`;
  const begin = await postUpload(url, JSON.stringify({
    action: "begin", name: file.name, mime: file.type || "application/octet-stream",
    scope: options.scope, folderId: options.folderId,
  }), "application/json");
  const sessionId = begin.session?.sessionId;
  const partSize = begin.session?.partSize;
  if (typeof sessionId !== "string" || !sessionId || typeof partSize !== "number"
    || !Number.isSafeInteger(partSize) || partSize <= 0) {
    throw new Error("Invalid upload session response.");
  }

  const totalParts = Math.max(1, Math.ceil(file.size / partSize));
  const parts: Array<{ partNumber: number; etag: string }> = [];
  options.onProgress?.(0, totalParts);
  for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
    const query = new URLSearchParams({ scope: options.scope, sessionId, partNumber: String(partNumber) });
    const result = await postUpload(`/api/files/uploads?${query}`,
      file.slice((partNumber - 1) * partSize, partNumber * partSize), "application/octet-stream");
    if (result.part?.partNumber !== partNumber || typeof result.part.etag !== "string" || !result.part.etag) {
      throw new Error(`Invalid upload response for part ${partNumber}.`);
    }
    parts.push({ partNumber, etag: result.part.etag });
    options.onProgress?.(partNumber, totalParts);
  }
  await postUpload(url, JSON.stringify({ action: "complete", sessionId, parts }), "application/json");
}
