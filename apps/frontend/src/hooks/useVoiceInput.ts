import { useCallback, useRef, useState } from "react";

const MAX_BYTES = 25 * 1024 * 1024;

export interface UseVoiceInputOptions {
  onTranscript: (text: string) => void;
  disabled?: boolean;
}

export function useVoiceInput({ onTranscript, disabled = false }: UseVoiceInputOptions) {
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mediaRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const stop = useCallback(() => {
    mediaRef.current?.stop();
    mediaRef.current = null;
    setRecording(false);
  }, []);

  const start = useCallback(async () => {
    if (disabled || recording || busy) return;
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        void (async () => {
          const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
          if (blob.size === 0) {
            setError("No audio captured.");
            return;
          }
          if (blob.size > MAX_BYTES) {
            setError("Recording exceeds 25 MB.");
            return;
          }
          setBusy(true);
          try {
            const form = new FormData();
            form.append("audio", blob, "voice.webm");
            const response = await fetch("/api/voice/transcribe", { method: "POST", credentials: "same-origin", body: form });
            const body = (await response.json()) as { ok?: boolean; text?: string; error?: string };
            if (!response.ok || !body.ok || !body.text) {
              setError(body.error ?? `Transcription failed (${response.status}).`);
              return;
            }
            onTranscript(body.text);
          } catch {
            setError("Transcription request failed.");
          } finally {
            setBusy(false);
          }
        })();
      };
      mediaRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch {
      setError("Microphone access is unavailable.");
    }
  }, [busy, disabled, onTranscript, recording]);

  const toggle = useCallback(() => {
    if (recording) stop();
    else void start();
  }, [recording, start, stop]);

  return { recording, busy, error, toggle, stop };
}