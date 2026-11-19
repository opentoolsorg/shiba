import type { JSX } from "react";
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
  const classes = `${className} inline-flex shrink-0`;
  if (decorative) {
    return (
      <span aria-hidden="true" className={classes}>
        <AgentMascot look={SHIBA_BRAND_LOOK} />
      </span>
    );
  }
  return (
    <span role="img" aria-label={label} className={classes}>
      <AgentMascot look={SHIBA_BRAND_LOOK} />
    </span>
  );
}
