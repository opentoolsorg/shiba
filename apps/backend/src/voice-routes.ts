import type { Env } from "./env.js";
import { isAuthorizedRequest } from "./request-auth.js";
import { redactSecrets } from "./security.js";

export const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";
export const MAX_VOICE_BYTES = 25 * 1024 * 1024;

export async function handleVoiceRoutes(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/voice/transcribe") return null;
  if (!(await isAuthorizedRequest(request, env))) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }
  const contentType = request.headers.get("content-type") ?? "";
  let audio: ArrayBuffer;
  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("audio");
    if (!(file instanceof File)) {
      return Response.json({ error: "Missing audio file." }, { status: 400 });
    }
    audio = await file.arrayBuffer();
  } else {
    audio = await request.arrayBuffer();
  }
  if (audio.byteLength === 0) {
    return Response.json({ error: "Audio body is empty." }, { status: 400 });
  }
  if (audio.byteLength > MAX_VOICE_BYTES) {
    return Response.json({ error: "Audio must be at most 25 MB." }, { status: 413 });
  }
  try {
    const bytes = new Uint8Array(audio);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const result = await env.AI.run(WHISPER_MODEL, { audio: btoa(binary) });
    const text = typeof (result as { text?: string }).text === "string" ? (result as { text: string }).text : "";
    return Response.json({ ok: true, text: text.trim() });
  } catch (error) {
    return Response.json({ ok: false, error: redactSecrets(error instanceof Error ? error.message : String(error)) }, { status: 502 });
  }
}