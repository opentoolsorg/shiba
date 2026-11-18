// Seeds two bots and two documents in the local D1 through the Worker APIs.
const BASE = process.env.VERIFY_APP_URL ?? "http://localhost:8788";
const ORIGIN = "http://localhost:8788";
// Local dev identity: with no Access/better-auth configured, the dashboard is
// authenticated by this header, so seeding uses the same user the browser will.
const USER = "me@local.test";
const headers = (extra = {}) => ({
  origin: ORIGIN,
  "content-type": "application/json",
  "CF-Access-Authenticated-User-Email": USER,
  ...extra,
});

async function json(path, init = {}) {
  const response = await fetch(`${BASE}${path}`, { ...init, headers: { ...headers(), ...(init.headers ?? {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${response.status} ${JSON.stringify(body)}`);
  return body;
}

async function ensureFile(name, mime, bytes, scope = "personal") {
  const existing = await json(`/api/files?scope=${scope}`);
  const found = existing.files.find((file) => file.name === name);
  if (found) return found;
  return upload(name, mime, bytes, scope);
}

async function ensureBot(slug, config) {
  const listed = await json("/api/custom-agents");
  const found = listed.agents.find((agent) => agent.slug === slug);
  if (!found) {
    const created = await json("/api/custom-agents", { method: "POST", headers: headers(), body: JSON.stringify({ slug, config }) });
    return created.agent;
  }
  const updated = await json(`/api/custom-agents/${encodeURIComponent(found.id)}`, {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify({ config, expectedVersion: found.version }),
  });
  return updated.agent;
}

async function upload(name, mime, bytes, scope = "personal") {
  const begin = await json("/api/files/uploads", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ action: "begin", name, mime, scope, folderId: null }),
  });
  const { sessionId, partSize } = begin.session;
  const parts = [];
  for (let offset = 0, partNumber = 1; offset < bytes.length; offset += partSize, partNumber++) {
    const chunk = bytes.subarray(offset, Math.min(offset + partSize, bytes.length));
    const response = await fetch(
      `${BASE}/api/files/uploads?${new URLSearchParams({ scope, sessionId, partNumber: String(partNumber) })}`,
      { method: "POST", headers: headers({ "content-type": "application/octet-stream" }), body: chunk },
    );
    const body = await response.json();
    if (!response.ok) throw new Error(`part ${partNumber} -> ${response.status} ${JSON.stringify(body)}`);
    parts.push({ partNumber, etag: body.part.etag });
  }
  await json("/api/files/uploads", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ action: "complete", sessionId, parts }),
  });
  const listed = await json(`/api/files?scope=${scope}`);
  const created = listed.files.filter((file) => file.name === name).pop();
  if (!created) throw new Error(`uploaded ${name} but it is not listed`);
  return created;
}

const encoder = new TextEncoder();
const brief = encoder.encode(
  Array.from({ length: 40 }, (_, index) => `# Finding ${index + 1}\n\nCitation ${index + 1} for the competitor brief.\n`).join("\n"),
);
// A permitted upload whose extension the in-panel viewer cannot render.
const docx = new Uint8Array(2048).fill(7);

const briefFile = await ensureFile("brief.md", "text/markdown", brief);
const docxFile = await ensureFile("sources.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", docx);

const research = await ensureBot("research-bot", {
  name: "Research bot",
  instructions: "Write research briefs. Cite sources.",
  harness: "opencode",
  expectedDeliverables: ["out/brief.md"],
  libraryFileIds: [briefFile.id, docxFile.id],
});
const engineering = await ensureBot("engineering-bot", {
  name: "Engineering bot",
  instructions: "Review diffs and write tests.",
  harness: "opencode",
  expectedDeliverables: ["out/fix.md"],
});

console.log(JSON.stringify({
  researchId: research.id,
  researchVersion: research.version,
  engineeringId: engineering.id,
  briefFileId: briefFile.id,
  docxFileId: docxFile.id,
  libraryFileIds: research.config.libraryFileIds,
}, null, 2));
