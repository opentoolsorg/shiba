/**
 * First-run setup wizard for `pnpm shiba setup` / `pnpm shiba dev`.
 * Node stdlib only. Never prints secret values. Every step can be skipped.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const SETUP_REL = ".shiba/setup.json";

export const WIZARD_CHOICES = {
  github: ["token", "app", "skip"],
  model: ["byom", "siwc", "api-key", "skip"],
  sandbox: ["cloudflare", "docker-local", "computesdk", "e2b"],
};

const LOCAL_CONTAINERS = new Set(["cloudflare", "docker-local"]);

export function emptyAnswers() {
  return {
    github: { mode: "skip" },
    model: { mode: "skip" },
    sandbox: { provider: "cloudflare" },
    testRepo: { url: "" },
  };
}

function oneOf(value, allowed, fallback) {
  return typeof value === "string" && allowed.includes(value) ? value : fallback;
}

/** Invalid input becomes a skip, never a throw. */
export function normalizeAnswers(input) {
  const raw = input && typeof input === "object" ? input : {};
  const github = raw.github && typeof raw.github === "object" ? raw.github : {};
  const model = raw.model && typeof raw.model === "object" ? raw.model : {};
  const sandbox = raw.sandbox && typeof raw.sandbox === "object" ? raw.sandbox : {};
  const testRepo = raw.testRepo && typeof raw.testRepo === "object" ? raw.testRepo : {};
  const githubMode = oneOf(github.mode, WIZARD_CHOICES.github, "skip");
  const modelMode = oneOf(model.mode, WIZARD_CHOICES.model, "skip");
  const provider = oneOf(sandbox.provider, WIZARD_CHOICES.sandbox, "cloudflare");
  const url = typeof testRepo.url === "string" ? testRepo.url.trim() : "";
  return {
    github: {
      mode: githubMode,
      ...(githubMode === "app" && typeof github.appId === "string" ? { appId: github.appId.trim() } : {}),
      ...(githubMode === "app" && typeof github.installationId === "string"
        ? { installationId: github.installationId.trim() }
        : {}),
      ...(githubMode === "token" && typeof github.token === "string" && github.token.trim()
        ? { token: github.token.trim() }
        : {}),
    },
    model: {
      mode: modelMode,
      ...(typeof model.baseUrl === "string" && model.baseUrl.trim() ? { baseUrl: model.baseUrl.trim() } : {}),
      ...(typeof model.credentialRef === "string" && model.credentialRef.trim()
        ? { credentialRef: model.credentialRef.trim() }
        : {}),
    },
    sandbox: { provider },
    testRepo: { url: /^https:\/\/github\.com\/[^/]+\/[^/]+/.test(url) ? url.replace(/\.git$/, "") : "" },
  };
}

export function splitSecrets(answers) {
  const secrets = {};
  const saved = normalizeAnswers(answers);
  if (saved.github.mode === "token" && saved.github.token) {
    secrets.GITHUB_TOKEN = saved.github.token;
    saved.github = { mode: "token", tokenStored: true };
  }
  return { saved, secrets };
}

export function devVarPatch(saved, secrets = {}) {
  const patch = { ...secrets };
  if (saved.sandbox?.provider) patch.SHIBA_SANDBOX_PROVIDER = saved.sandbox.provider;
  if (saved.github?.mode === "app") {
    if (saved.github.appId) patch.GITHUB_APP_ID = saved.github.appId;
    if (saved.github.installationId) patch.GITHUB_APP_INSTALLATION_ID = saved.github.installationId;
  }
  if (saved.model?.mode === "siwc") patch.SHIBA_CODEX_SUBSCRIPTION = "1";
  return patch;
}

export function needsLocalContainers(record) {
  if (record?.containers === false) return false;
  const provider = record?.answers?.sandbox?.provider ?? "cloudflare";
  return LOCAL_CONTAINERS.has(provider);
}

function finding(id, severity, message, fixAction) {
  return { id, severity, message, ...(fixAction ? { fixAction } : {}) };
}

export function localDoctor(record, ctx = {}) {
  const answers = record?.answers ?? emptyAnswers();
  const keys = ctx.devVarKeys ?? new Set();
  const findings = [];
  const acknowledged = new Set(record?.acknowledged ?? []);

  const githubReady =
    (answers.github.mode === "token" && (answers.github.tokenStored || keys.has("GITHUB_TOKEN"))) ||
    (answers.github.mode === "app" && answers.github.appId && keys.has("GITHUB_APP_PRIVATE_KEY"));
  if (githubReady) {
    findings.push(finding("github.credentials", "ok", "GitHub credentials are recorded for local dev."));
  } else if (!acknowledged.has("github.credentials")) {
    findings.push(
      finding(
        "github.credentials",
        "warn",
        answers.github.mode === "skip"
          ? "GitHub is skipped — clone and pull requests stay off until you add a token or a GitHub App."
          : "GitHub is not finished — the private key or token is not in .dev.vars yet.",
        { id: "guide.github", label: "Add a GitHub token or GitHub App", kind: "guide" },
      ),
    );
  }

  const modelReady = answers.model.mode === "siwc" || (answers.model.mode !== "skip" && (answers.model.baseUrl || answers.model.credentialRef));
  if (modelReady) {
    findings.push(finding("model.connection", "ok", `Model path: ${answers.model.mode}.`));
  } else if (!acknowledged.has("model.connection")) {
    findings.push(
      finding(
        "model.connection",
        "warn",
        "No model connection yet. Choose BYOM, Sign in with ChatGPT, or an API key alias.",
        { id: "guide.model", label: "Connect a model", kind: "guide" },
      ),
    );
  }

  const provider = answers.sandbox.provider;
  if (LOCAL_CONTAINERS.has(provider) && ctx.dockerOk === false && record?.containers !== false) {
    findings.push(
      finding(
        "sandbox.docker",
        "warn",
        "Docker is not running, so local containers cannot start.",
        { id: "sandbox.without-docker", label: "Continue without local containers", kind: "apply" },
      ),
    );
  } else {
    findings.push(
      finding(
        "sandbox.provider",
        "ok",
        record?.containers === false
          ? `Sandbox provider ${provider}; containers disabled for this dev process.`
          : `Sandbox provider ${provider}.`,
      ),
    );
  }

  if (!answers.testRepo.url && !acknowledged.has("testRepo")) {
    findings.push(
      finding(
        "testRepo",
        "warn",
        "No test repository yet. Real GitHub journeys need one; mock journeys can skip it.",
        { id: "guide.test-repo", label: "Set a test repository", kind: "guide" },
      ),
    );
  } else if (answers.testRepo.url) {
    findings.push(finding("testRepo", "ok", `Test repository ${answers.testRepo.url}.`));
  }

  const ok = !findings.some((item) => item.severity === "error");
  return { ok, findings };
}

export function applyFix(record, actionId) {
  const next = {
    version: 1,
    answers: normalizeAnswers(record?.answers ?? {}),
    containers: record?.containers !== false,
    acknowledged: [...(record?.acknowledged ?? [])],
    updatedAt: new Date().toISOString(),
  };
  const ack = (id) => {
    if (!next.acknowledged.includes(id)) next.acknowledged.push(id);
  };
  if (actionId === "sandbox.without-docker") {
    next.containers = false;
    ack("sandbox.docker");
    return { record: next, message: "Continuing without local containers. Re-run setup when Docker is up.", deadEnd: false };
  }
  if (actionId === "sandbox.use-cloudflare") {
    next.answers.sandbox.provider = "cloudflare";
    next.containers = true;
    return { record: next, message: "Sandbox provider set to cloudflare.", deadEnd: false };
  }
  if (actionId === "sandbox.use-docker-local") {
    next.answers.sandbox.provider = "docker-local";
    next.containers = true;
    return { record: next, message: "Sandbox provider set to docker-local.", deadEnd: false };
  }
  if (actionId === "sandbox.use-computesdk" || actionId === "sandbox.use-e2b") {
    next.answers.sandbox.provider = actionId === "sandbox.use-e2b" ? "e2b" : "computesdk";
    next.containers = false;
    return { record: next, message: `Sandbox provider set to ${next.answers.sandbox.provider}.`, deadEnd: false };
  }
  if (actionId === "guide.github") {
    ack("github.credentials");
    return {
      record: next,
      message: "Add GITHUB_TOKEN or GitHub App vars to apps/backend/.dev.vars, then pnpm shiba doctor.",
      deadEnd: false,
    };
  }
  if (actionId === "guide.model") {
    ack("model.connection");
    return {
      record: next,
      message: "Connect BYOM, Sign in with ChatGPT, or an API key alias, then pnpm shiba doctor.",
      deadEnd: false,
    };
  }
  if (actionId === "guide.test-repo") {
    ack("testRepo");
    return { record: next, message: "Skipped the test repository. Export SHIBA_TEST_REPO when you have one.", deadEnd: false };
  }
  return { record: next, message: `No setup action named ${actionId}. Run pnpm shiba setup to pick a step.`, deadEnd: false };
}

export function buildRecord(answers, ctx = {}) {
  const { saved } = splitSecrets(answers);
  let record = {
    version: 1,
    answers: saved,
    containers: ctx.containers !== false && (ctx.dockerOk !== false || !LOCAL_CONTAINERS.has(saved.sandbox.provider)),
    acknowledged: [],
    updatedAt: new Date().toISOString(),
    completed: false,
  };
  if (ctx.dockerOk === false && needsLocalContainers(record)) {
    record = applyFix(record, "sandbox.without-docker").record;
  }
  const doctor = localDoctor(record, ctx);
  record.completed = doctor.ok && !doctor.findings.some((item) => item.severity === "error");
  return { record, doctor };
}

export function mergeDevVarsText(text, patch) {
  const lines = text.length > 0 ? text.replace(/\n?$/, "\n").split("\n") : [];
  const keys = new Set(Object.keys(patch));
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      out.push(line);
      continue;
    }
    const name = trimmed.slice(0, trimmed.indexOf("=")).trim();
    if (keys.has(name)) {
      out.push(`${name}=${patch[name]}`);
      seen.add(name);
    } else {
      out.push(line);
    }
  }
  const missing = [...keys].filter((key) => !seen.has(key));
  if (missing.length > 0) {
    if (!out.some((line) => line.includes("pnpm shiba setup"))) {
      out.push("# --- pnpm shiba setup ---");
    }
    for (const key of missing) out.push(`${key}=${patch[key]}`);
  }
  return `${out.filter((line, index) => line !== "" || index < out.length - 1).join("\n").replace(/\n*$/, "\n")}`;
}

export function publicRecord(record) {
  return JSON.parse(JSON.stringify(record, (key, value) => (key === "token" || key === "privateKey" || key === "apiKey" ? undefined : value)));
}

export function formatDoctor(doctor) {
  const lines = [doctor.ok ? "setup doctor: ok" : "setup doctor: follow the actions below"];
  for (const item of doctor.findings) {
    const tag = item.severity === "ok" ? "✓" : item.severity === "warn" ? "!" : "✗";
    lines.push(`${tag} ${item.id}: ${item.message}`);
    if (item.fixAction) lines.push(`    action: ${item.fixAction.id} — ${item.fixAction.label}`);
  }
  return lines.join("\n");
}

export function readSetupFile(path) {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeSetupFile(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(publicRecord(record), null, 2)}\n`, { mode: 0o600 });
}

/**
 * Scripted fresh clone: no .dev.vars, Docker down, then one-click fixes
 * until every finding has a next step. Throws if a step is a dead end.
 */
export function walkthroughFreshClone() {
  const lines = [];
  const push = (line) => lines.push(line);
  push("shiba fresh-clone walkthrough");
  push("start: empty checkout, no .dev.vars, Docker unavailable");
  const answers = {
    github: { mode: "skip" },
    model: { mode: "byom", baseUrl: "https://models.example/v1", credentialRef: "byok-local" },
    sandbox: { provider: "cloudflare" },
    testRepo: { url: "" },
  };
  push("wizard: github=skip");
  push("wizard: model=byom baseUrl=https://models.example/v1 credentialRef=byok-local");
  push("wizard: sandbox=cloudflare");
  push("wizard: testRepo=skip");
  let { record, doctor } = buildRecord(answers, { dockerOk: false, devVarKeys: new Set() });
  push(formatDoctor(doctor));
  const actionable = doctor.findings.filter((item) => item.severity !== "ok");
  for (const item of actionable) {
    if (!item.fixAction) {
      throw new Error(`dead end: ${item.id} has no fix`);
    }
    const applied = applyFix(record, item.fixAction.id);
    if (applied.deadEnd) throw new Error(`dead end: ${item.fixAction.id}`);
    record = applied.record;
    push(`fix ${item.fixAction.id}: ${applied.message}`);
  }
  doctor = localDoctor(record, { dockerOk: false, devVarKeys: new Set() });
  push(formatDoctor(doctor));
  if (doctor.findings.some((item) => item.severity === "error" || (item.severity === "warn" && !item.fixAction && item.severity !== "ok"))) {
    const blocking = doctor.findings.filter((item) => item.severity === "error" || (item.severity === "warn" && !item.fixAction));
    if (blocking.length > 0) throw new Error(`dead end: ${blocking.map((item) => item.id).join(",")}`);
  }
  if (needsLocalContainers(record)) throw new Error("dead end: containers still required without Docker");
  const patch = devVarPatch(record.answers, {});
  const vars = mergeDevVarsText("# fresh\n", patch);
  if (/ghp_|github_pat_|sk-|BEGIN/.test(vars) || /ghp_|github_pat_/.test(JSON.stringify(publicRecord(record)))) {
    throw new Error("walkthrough leaked a secret");
  }
  push(`dev vars keys: ${[...Object.keys(patch)].sort().join(",")}`);
  push(`containers: ${record.containers === false ? "disabled" : "enabled"}`);
  push("next: pnpm shiba dev --skip-setup");
  push("next: pnpm shiba doctor");
  push("result: no dead ends");
  return { ok: true, log: lines.join("\n"), record };
}

export function setupPath(root) {
  return resolve(root, SETUP_REL);
}

/** Persist a redacted setup record. Secrets stay in the returned patch, never in the file. */
export function commitSetup(root, answers, ctx = {}) {
  const { saved, secrets } = splitSecrets(normalizeAnswers(answers));
  const built = buildRecord(saved, ctx);
  writeSetupFile(setupPath(root), built.record);
  return { ...built, secrets, patch: devVarPatch(built.record.answers, secrets) };
}
