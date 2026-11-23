import { useState, type JSX } from "react";
import type { AgentMascotLook } from "@shiba/shared";
import { AgentMascot } from "./AgentMascot";

/**
 * The brand mark: the pointed-ear Shiba at her resting face. Same drawing as
 * the public mark in apps/web/public/landing/shiba-mark.svg and the app icons
 * in apps/frontend/public/brand, so the site, the app and the installer show
 * one mark. Decorative wherever it sits beside the word Shiba.
 */
export const SHIBA_BRAND_LOOK: AgentMascotLook = { shape: "pointed", color: "#c4a574", eyes: "happy", acc: "none" };

export function ShibaMark({ className = "size-14", decorative = false, label = "Shiba" }: { className?: string; decorative?: boolean; label?: string }): JSX.Element {
  const [imageFailed, setImageFailed] = useState(false);
  const classes = `${className} inline-flex shrink-0`;
  const mark = imageFailed
    ? <AgentMascot look={SHIBA_BRAND_LOOK} />
    : <img src="/assets/mascot/pet-logo.png" alt="" aria-hidden="true" onError={() => setImageFailed(true)} className="size-full rounded-[inherit] object-cover" />;
  if (decorative) return <span aria-hidden="true" className={classes}>{mark}</span>;
  return <span role="img" aria-label={label} className={classes}>{mark}</span>;
}
