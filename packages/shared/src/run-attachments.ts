/** T69: a file the human attached to a run. The approval hash binds name, sha256 and size. */
export interface RunAttachment {
  name: string;
  sha256: string;
  size: number;
}

export const MAX_RUN_ATTACHMENTS = 8;
export const MAX_RUN_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_RUN_ATTACHMENTS_TOTAL_BYTES = 25 * 1024 * 1024;
// A bare file name with no separator or leading dot, so it can't leave `.shiba/attachments/`.
export const RUN_ATTACHMENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._ ()-]{0,119}$/;

/** Throws a user-facing message on any problem; an absent or empty list is undefined. */
export function parseRunAttachments(value: unknown): RunAttachment[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error("attachments must be a list.");
  if (value.length === 0) return undefined;
  if (value.length > MAX_RUN_ATTACHMENTS) throw new Error(`A run takes at most ${MAX_RUN_ATTACHMENTS} attachments.`);
  const names = new Set<string>();
  let total = 0;
  return value.map((item: unknown) => {
    const { name, sha256, size } = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    if (typeof name !== "string" || !RUN_ATTACHMENT_NAME.test(name)) {
      throw new Error(`Attachment name ${JSON.stringify(name)} isn't allowed.`);
    }
    if (names.has(name)) throw new Error(`Two attachments are named ${name}.`);
    names.add(name);
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`Attachment ${name} has no valid sha256.`);
    if (typeof size !== "number" || !Number.isInteger(size) || size < 0 || size > MAX_RUN_ATTACHMENT_BYTES) {
      throw new Error(`Attachment ${name} must be at most ${MAX_RUN_ATTACHMENT_BYTES} bytes.`);
    }
    total += size;
    if (total > MAX_RUN_ATTACHMENTS_TOTAL_BYTES) {
      throw new Error(`Attachments must total at most ${MAX_RUN_ATTACHMENTS_TOTAL_BYTES} bytes.`);
    }
    return { name, sha256, size };
  });
}
