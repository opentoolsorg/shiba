/** Generated media uses authenticated API downloads, never provider URLs. */
export function VideoArtifactPlayer({ src, title = "Generated video" }: { src: string; title?: string }) {
  if (!src.startsWith("/api/") || /[\\\r\n]/.test(src)) return null;
  return (
    // biome-ignore lint/a11y/useMediaCaption: The generation provider does not return a caption track.
    <video
      aria-label={title}
      controls
      preload="metadata"
      src={src}
      className="w-full max-w-xl border border-[var(--border-1)]"
    >
      <a href={src}>Download {title}</a>
    </video>
  );
}

export function generatedVideoSource(output: unknown): string | null {
  if (typeof output !== "object" || output === null) return null;
  const result = output as Record<string, unknown>;
  return result.ok === true && result.mime === "video/mp4" && typeof result.downloadPath === "string"
    ? result.downloadPath : null;
}
