import { integrationLogos } from "@shiba/shared";
import { useState, type JSX } from "react";

function providerLogo(value?: string | null): string | null {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export function IntegrationLogo({ providerKey, logoUrl }: { providerKey: string; logoUrl?: string | null }): JSX.Element {
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const known = integrationLogos(providerKey);
  const upstream = providerLogo(logoUrl);
  const logos = known.length ? known : upstream ? [{ name: providerKey, src: upstream }] : [];
  const visible = logos.filter((logo) => !failed.has(logo.src));
  return (
    <span className="inline-flex shrink-0 items-center gap-1" aria-hidden="true">
      {visible.length ? visible.map((logo) => (
        <img key={logo.src} src={logo.src} alt="" width={32} height={32}
          referrerPolicy="no-referrer"
          className="h-8 w-8 shrink-0 rounded border border-[var(--border-1)] bg-white object-contain p-1"
          onError={() => setFailed((previous) => new Set([...previous, logo.src]))} />
      )) : (
        <span className="flex h-8 w-8 items-center justify-center rounded border border-[var(--border-1)] text-[var(--muted-foreground-2)]">
          <svg aria-hidden="true" focusable="false" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M9 3v4m6-4v4M7 7h10v4a5 5 0 0 1-10 0V7Zm5 9v5" /></svg>
        </span>
      )}
    </span>
  );
}
