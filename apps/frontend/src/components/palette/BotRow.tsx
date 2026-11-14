import type { JSX } from "react";
import { AgentAvatar } from "../AgentAvatar";
import type { PaletteBot } from "./usePaletteBots";

export function botOptionName(bot: PaletteBot): string {
  const state = bot.state === "needs_you" ? "needs you" : bot.state;
  const parts = [bot.name, state];
  if (typeof bot.unread === "number") parts.push(bot.unread > 9 ? "9+ unread" : `${bot.unread} unread`);
  if (bot.preview) parts.push(`last message: ${bot.preview}`);
  return parts.join(", ");
}

export function BotRow({ bot, shortcut }: { bot: PaletteBot; shortcut: string | null }): JSX.Element {
  const status = bot.state === "working" ? "working" : bot.state === "needs_you" ? "needs-approval" : undefined;
  const stateLabel = bot.state === "needs_you" ? "needs you" : bot.state;
  return (
    <span className="flex min-h-11 w-full items-center gap-3">
      <span className="sr-only">{botOptionName(bot)}</span>
      <AgentAvatar id={bot.agentId} name={bot.name} size={28} status={status} mascotPreset={bot.avatar?.mascotPreset} look={bot.avatar?.look} decorative />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-[var(--fg)]">{bot.name} <span className="text-[var(--muted-foreground-2)]">{stateLabel}</span></span>
        {bot.preview ? <span className="block truncate text-xs text-[var(--muted-foreground-2)]">{bot.preview}</span> : null}
      </span>
      {typeof bot.unread === "number" ? <span className="rounded-full bg-[var(--primary-soft)] px-2 py-0.5 text-[10px]">{bot.unread > 9 ? "9+" : bot.unread}</span> : null}
      {shortcut ? <span aria-hidden="true" className="font-mono text-[10px] text-[var(--muted-foreground-2)]">{shortcut}</span> : null}
    </span>
  );
}
