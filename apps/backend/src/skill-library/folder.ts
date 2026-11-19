import { zipSync } from "fflate";
import { isMap, parseDocument, stringify } from "yaml";
import { z } from "zod";

const FILE_LIMIT = 64;
const FOLDER_BYTES = 512 * 1024;
const SKILL_BYTES = 64 * 1024;
const REQUEST_BYTES = 740 * 1024;
const segment = /^[a-z0-9_-][a-z0-9_. -]{0,79}$/i;
const reserved = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;
const portableSegment = (value: string) => segment.test(value) && !/[ .]$/.test(value) && !reserved.test(value);
const base64 = /^[A-Za-z0-9+/]*={0,2}$/;
const decodeBase64 = (value: string) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

const folderSchema = z.object({
  folder: z.string().refine(portableSegment),
  files: z.array(z.object({ path: z.string().max(200), base64: z.string().max(Math.ceil(FOLDER_BYTES / 3) * 4).regex(base64).refine((value) => value.length % 4 === 0) })).min(1).max(FILE_LIMIT),
});
const importSchema = folderSchema.extend({ scope: z.enum(["personal", "workspace"]) });

export class SkillFolderError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

function markdown(content: string) {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m.exec(content);
  if (!match || match.index !== 0) throw new SkillFolderError("SKILL.md must start with YAML frontmatter.");
  const [heading, frontmatter = ""] = match;
  let yaml: ReturnType<typeof parseDocument>;
  try { yaml = parseDocument(frontmatter, { schema: "core", uniqueKeys: true }); }
  catch { throw new SkillFolderError("SKILL.md has invalid YAML frontmatter."); }
  if (!isMap(yaml.contents) || yaml.errors.length || yaml.warnings.length) throw new SkillFolderError("SKILL.md has invalid YAML frontmatter.");
  const name = yaml.get("name"), description = yaml.get("description");
  if (typeof name !== "string" || !name.trim() || typeof description !== "string") {
    throw new SkillFolderError("SKILL.md requires text name and description fields.");
  }
  return { yaml, name, description, instructions: content.slice(heading.length), heading };
}

export async function readSkillFolder(request: Request) {
  const tooLarge = () => new SkillFolderError("Skill folder exceeds the upload limit.", 413);
  if (Number(request.headers.get("Content-Length")) > REQUEST_BYTES) throw tooLarge();
  if (!request.body) throw new SkillFolderError("Choose a skill folder.");
  const reader = request.body.getReader();
  const buffer = new Uint8Array(REQUEST_BYTES);
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (size + value.length > buffer.length) throw tooLarge();
      buffer.set(value, size);
      size += value.length;
    }
  } finally { void reader.cancel().catch(() => {}); }
  let data: unknown;
  try { data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size))); }
  catch { throw new SkillFolderError("Invalid skill folder request."); }
  const parsed = importSchema.safeParse(data);
  if (!parsed.success) throw new SkillFolderError("Use a portable folder name and at most 64 files.");
  const { scope, ...folder } = parsed.data;
  const paths = new Map<string, { spelling: string; file: boolean }>();
  let bytes = 0;
  let root: string | undefined;
  for (const file of folder.files) {
    const parts = file.path.split("/");
    const [directory] = parts;
    if (!parts.every(portableSegment) || (file.path !== "SKILL.md" && (parts.length < 2 || !directory || !["assets", "references", "scripts"].includes(directory)))) {
      throw new SkillFolderError("Only SKILL.md and safe files under scripts, references, or assets are allowed.");
    }
    for (let count = 1; count <= parts.length; count++) {
      const spelling = parts.slice(0, count).join("/");
      const key = spelling.toLowerCase();
      const leaf = count === parts.length;
      const prior = paths.get(key);
      if (prior && (prior.file || leaf || prior.spelling !== spelling)) throw new SkillFolderError("The folder contains conflicting paths.");
      paths.set(key, { spelling, file: leaf });
    }
    const length = (file.base64.length / 4) * 3 - (file.base64.endsWith("==") ? 2 : file.base64.endsWith("=") ? 1 : 0);
    bytes += length;
    if (bytes > FOLDER_BYTES || (file.path === "SKILL.md" && length > SKILL_BYTES)) throw tooLarge();
    if (file.path === "SKILL.md") {
      try { root = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(decodeBase64(file.base64)); }
      catch { throw new SkillFolderError("SKILL.md must be valid UTF-8."); }
    }
  }
  if (root === undefined) throw new SkillFolderError("The folder must contain a root SKILL.md.");
  const { name, description, instructions } = markdown(root);
  return { scope, name, description, instructions, folderJson: JSON.stringify(folder) };
}

export function skillFolderDownload(skill: { name: string; description: string; instructions: string }, folderJson: string | null) {
  const bundle = folderJson ? folderSchema.parse(JSON.parse(folderJson)) : null;
  const slug = skill.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60).replace(/^-+|-+$/g, "");
  const folder = bundle?.folder ?? (portableSegment(slug) ? slug : "skill");
  const files: Record<string, Uint8Array> = {};
  let heading = `---\n${stringify({ name: skill.name, description: skill.description })}---\n`;
  for (const file of bundle?.files ?? []) {
    const bytes = decodeBase64(file.base64);
    if (file.path !== "SKILL.md") {
      files[`${folder}/${file.path}`] = bytes;
      continue;
    }
    const parsed = markdown(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes));
    if (parsed.name === skill.name && parsed.description === skill.description) heading = parsed.heading;
    else {
      parsed.yaml.set("name", skill.name);
      parsed.yaml.set("description", skill.description);
      heading = `---\n${String(parsed.yaml)}---\n`;
    }
    if (skill.instructions && !heading.endsWith("\n")) heading += "\n";
  }
  files[`${folder}/SKILL.md`] = new TextEncoder().encode(heading + skill.instructions);
  return new Response(zipSync(files, { level: 0 }), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": 'attachment; filename="skill-folder.zip"',
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
