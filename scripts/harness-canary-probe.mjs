import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pins from "./harness-canary-pins.json" with { type: "json" };

const root = fileURLToPath(new URL("..", import.meta.url));
const imageRef = /^[a-z0-9][a-z0-9.:-]*\/[a-z0-9/_.-]+@sha256:[a-f0-9]{64}$/;
const maxBody = 256 * 1024;
const metadataOnly = {
  openai: ["https://api.openai.com/v1/models/", "SHIBA_CANARY_OPENAI_KEY", "Authorization"],
  anthropic: ["https://api.anthropic.com/v1/models/", "SHIBA_CANARY_ANTHROPIC_KEY", "x-api-key"],
  google: ["https://generativelanguage.googleapis.com/v1beta/models/", "SHIBA_CANARY_GOOGLE_KEY", "x-goog-api-key"],
  xai: ["https://api.x.ai/v1/models/", "SHIBA_CANARY_XAI_KEY", "Authorization"],
};

const requiredModels = [...new Set(Object.values(pins.lanes).map(([, model]) => model))].sort();
const outcome = (status, reason) => ({ status, reason });

export function isPinnedImage(value) {
  return typeof value === "string" && imageRef.test(value);
}

export function imageInputHash() {
  const hash = createHash("sha256");
  for (const path of pins.imageInputs) {
    hash.update(`${path}\0`).update(createHash("sha256").update(readFileSync(resolve(root, path))).digest());
  }
  return hash.digest("hex");
}

export function probeImage(env, run = spawnSync) {
  const image = env.SHIBA_CANARY_IMAGE;
  if (!isPinnedImage(image) || env.SHIBA_CANARY_IMAGE_INPUTS_SHA256 !== imageInputHash()) {
    return outcome("inconclusive", "unverified-image-pin");
  }
  const opts = { encoding: "utf8", maxBuffer: 128 * 1024, env: { PATH: env.PATH, HOME: env.HOME } };
  const details = run("docker", ["image", "inspect", "--format", "{{.Os}}/{{.Architecture}} {{json .RepoDigests}}", image], {
    ...opts, timeout: 10_000, killSignal: "SIGKILL",
  });
  if (details.status !== 0) return outcome("inconclusive", "image-not-preloaded");
  try {
    const [platform, digests] = details.stdout.trim().split(/ (.+)/);
    if (platform !== "linux/amd64" || !JSON.parse(digests).includes(image)) {
      return outcome("inconclusive", "unverified-image-pin");
    }
  } catch {
    return outcome("inconclusive", "unverified-image-pin");
  }
  const script = [
    'npm_root=$(npm root -g)',
    'for spec do',
    `  package=\${spec%%=*}; rest=\${spec#*=}; bin=\${rest%%=*}; want=\${rest#*=}`,
    '  command -v "$bin" >/dev/null',
    '  node -e \'if (require(process.argv[1]).version !== process.argv[2]) process.exit(1)\' "$npm_root/$package/package.json" "$want"',
    '  case "$bin" in',
    '    claude-agent-acp|codex-acp) ;;',
    '    *) version=$("$bin" --version); case " $version " in *" $want "*|*" v$want "*) :;; *) exit 1;; esac ;;',
    '  esac',
    'done',
  ].join("\n");
  const name = `shiba-harness-canary-${randomUUID()}`;
  const check = run("docker", [
    "run", "--rm", "--name", name, "--pull=never", "--platform", "linux/amd64", "--network", "none",
    "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--pids-limit", "128", "--cpus", "2", "--memory", "1g",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m", "--env", "HOME=/tmp",
    "--env", "XDG_CONFIG_HOME=/tmp/shiba-config", "--env", "XDG_CACHE_HOME=/tmp/shiba-cache",
    "--entrypoint", "/bin/sh", image, "-eu", "-c", script, "shiba-canary",
    ...Object.entries(pins.cli).map(([name, [bin, version]]) => `${name}=${bin}=${version}`),
  ], { ...opts, timeout: 90_000, killSignal: "SIGKILL" });
  if (check.error || check.signal) run("docker", ["rm", "-f", name], { ...opts, timeout: 5_000, killSignal: "SIGKILL" });
  if (check.error?.code === "ETIMEDOUT") return outcome("failed", "image-probe-timeout");
  if (check.error || check.status === 125) return outcome("inconclusive", "image-probe-not-started");
  return check.status === 0 ? outcome("passed", "pinned-clis-present") : outcome("failed", "cli-pin-or-startup-mismatch");
}

export async function readBoundedJson(response, limit = maxBody) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("missing response body");
  const text = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let decoded = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return JSON.parse(decoded + text.decode());
      size += value.byteLength;
      if (size > limit) throw new Error("response too large");
      decoded += text.decode(value, { stream: true });
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
}

async function probeModel(model, env, fetchImpl, deadlineMs) {
  const [provider, id] = model.split("/");
  const [base, keyName, header] = metadataOnly[provider];
  const key = env[keyName]?.trim();
  if (!key) return outcome("inconclusive", "metadata-credential-not-configured");
  const headers = { accept: "application/json", [header]: header === "Authorization" ? `Bearer ${key}` : key };
  if (provider === "anthropic") headers["anthropic-version"] = "2023-06-01";
  const signal = AbortSignal.timeout(deadlineMs);
  let response;
  try {
    response = await fetchImpl(base + encodeURIComponent(id), { headers, method: "GET", redirect: "error", signal });
  } catch {
    return outcome("failed", signal.aborted ? "metadata-timeout" : "metadata-transport-failure");
  }
  if (response.status !== 200) {
    void response.body?.cancel().catch(() => {});
    if (response.status === 404) return outcome("failed", "model-not-visible");
    if (response.status === 401 || response.status === 403) return outcome("failed", "metadata-auth-denied");
    if (response.status === 429) return outcome("failed", "metadata-rate-limited");
    return outcome("failed", "metadata-http-failure");
  }
  try {
    const data = await readBoundedJson(response);
    if (provider === "google") {
      if (data?.name !== `models/${id}` || !Array.isArray(data.supportedGenerationMethods) ||
        !data.supportedGenerationMethods.every((method) => typeof method === "string")) {
        return outcome("failed", "invalid-model-metadata");
      }
      if (!data.supportedGenerationMethods.includes("generateContent")) return outcome("failed", "model-capability-unavailable");
    } else if (data?.id !== id) {
      return outcome("failed", "invalid-model-metadata");
    }
    return outcome("passed", "exact-model-visible");
  } catch {
    return outcome("failed", signal.aborted ? "metadata-timeout" : "invalid-model-metadata");
  }
}

export async function probeModels(env, fetchImpl = fetch, deadlineMs = 8_000) {
  return Object.fromEntries(await Promise.all(requiredModels.map(async (model) => [
    model, await probeModel(model, env, fetchImpl, deadlineMs),
  ])));
}

async function main() {
  const [mode, output] = process.argv.slice(2);
  const env = process.env;
  if (!output) throw new Error("Missing canary report path.");
  if (mode === "image-hash") {
    writeFileSync(output, `${imageInputHash()}\n`);
  } else if (mode === "image" || mode === "models") {
    const evidence = mode === "image" ? {
      image: isPinnedImage(env.SHIBA_CANARY_IMAGE) ? env.SHIBA_CANARY_IMAGE : null,
      inputsSha256: imageInputHash(),
      ...probeImage(env),
    } : await probeModels(env);
    writeFileSync(output, `${JSON.stringify({
      revision: env.GITHUB_SHA, run: Number(env.GITHUB_RUN_NUMBER), evidence,
    }, null, 2)}\n`);
  } else {
    throw new Error("Unknown canary probe.");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
