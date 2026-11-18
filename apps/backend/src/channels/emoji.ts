// Reactions are named Slack-style ("eyes"); Discord and Telegram need the Unicode glyph.
const GLYPHS: Readonly<Record<string, string>> = {
  eyes: "👀",
  "+1": "👍",
  thumbsup: "👍",
  "-1": "👎",
  thumbsdown: "👎",
  white_check_mark: "✅",
  heavy_check_mark: "✔️",
  x: "❌",
  warning: "⚠️",
  hourglass: "⌛",
  hourglass_flowing_sand: "⏳",
  rocket: "🚀",
  tada: "🎉",
  fire: "🔥",
  zap: "⚡",
  heart: "❤️",
  pray: "🙏",
  thinking_face: "🤔",
  ok_hand: "👌",
  raised_hands: "🙌",
};

const NAMES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(GLYPHS).map(([name, glyph]) => [glyph, name]),
);

/** Unicode glyph for a reaction given as a name or `:name:`; glyphs pass through. */
export function reactionGlyph(emoji: string): string {
  const name = emoji.replace(/^:|:$/g, "");
  return Object.hasOwn(GLYPHS, name) ? (GLYPHS[name] as string) : emoji;
}

/** Slack reaction name for a reaction given as a name, `:name:` or a known glyph. */
export function reactionName(emoji: string): string {
  return Object.hasOwn(NAMES, emoji) ? (NAMES[emoji] as string) : emoji.replace(/^:|:$/g, "");
}
