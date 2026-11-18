/** Text hygiene shared by the navigation gate and the log writer. */

/** True for any C0 control character other than tab, or for DEL. */
function isControl(code: number): boolean {
  return (code < 0x20 && code !== 0x09) || code === 0x7f;
}

/** True when the value carries a control character, newline included. */
export function hasControlChars(value: string): boolean {
  for (const char of value) {
    if (isControl(char.codePointAt(0) ?? 0)) return true;
  }
  return false;
}

/** The same value with control characters removed, so one entry stays one line. */
export function stripControlChars(value: string): string {
  let out = "";
  for (const char of value) {
    if (isControl(char.codePointAt(0) ?? 0)) continue;
    out += char;
  }
  return out;
}
