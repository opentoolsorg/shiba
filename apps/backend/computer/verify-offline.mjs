import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const PROXIES = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "FTP_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "ftp_proxy"];
const HASH = (value) => createHash("sha256").update(value).digest("hex");
const DOCKER = ["--host=unix:///var/run/docker.sock"];
export function runtimeArguments(name, imageId, expiresAt) {
  if (!/^shiba-computer-acceptance-[a-f0-9]{32}$/.test(name) || !/^sha256:[a-f0-9]{64}$/.test(imageId) || !Number.isSafeInteger(expiresAt)) throw new Error("Invalid local acceptance scope");
  return ["run", "--detach", "--pull=never", "--name", name, "--network=none", "--cpus=0.5", "--memory=1g", "--pids-limit=256", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
    "--tmpfs=/tmp:rw,nosuid,nodev,size=134217728", "--tmpfs=/home/desktop:rw,nosuid,nodev,size=16777216", "--tmpfs=/run:rw,nosuid,nodev,size=8388608",
    ...PROXIES.flatMap((key) => ["--env", `${key}=`]), "--env", `SHIBA_COMPUTER_EXPIRES_AT=${expiresAt}`, imageId];
}
export function dockerEnvironment(source = process.env) {
  const env = { ...source }; for (const key of ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"]) delete env[key];
  // Preserve client registry/proxy configuration for the selected local daemon.
  // Only the explicit --env arguments above reach the offline runtime.
  return env;
}
async function command(args, { timeoutMs = 10000, maxBytes = 262144, binary = false } = {}) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn("docker", [...DOCKER, ...args], { env: dockerEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
    let size = 0, settled = false; const stdout = [], stderr = [];
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolveCommand(result); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new Error("Local Docker acceptance command timed out")); }, timeoutMs);
    const append = (target, chunk) => { size += chunk.byteLength; if (size > maxBytes) { child.kill("SIGKILL"); finish(new Error("Local Docker acceptance output exceeded bounds")); return; } target.push(chunk); };
    child.stdout.on("data", (chunk) => append(stdout, chunk)); child.stderr.on("data", (chunk) => append(stderr, chunk)); child.on("error", () => finish(new Error("Local Docker daemon/CLI unavailable")));
    child.on("close", (code) => { const value = Buffer.concat(stdout); if (code !== 0) finish(new Error(`Local Docker acceptance command failed (${code ?? "unknown"})`)); else finish(null, binary ? value : value.toString("utf8")); });
  });
}
function assert(value, message) { if (!value) throw new Error(message); }
export async function verifyOfflineComputer({ image, output }) {
  if (typeof image !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9./:@_-]{1,380}$/.test(image)) throw new Error("Provide an explicit existing local image with --image");
  const destination = resolve(output), name = `shiba-computer-acceptance-${randomUUID().replaceAll("-", "")}`;
  await mkdir(destination, { recursive: false });
  const report = { kind: "actual-local-Docker-offline-desktop", startedAt: new Date().toISOString(), boundary: "Real local Docker/Xvfb/Openbox/Chromium/xdotool/scrot only. No Cloudflare start, native app authentication, funding grant, multiplayer transport, provider, model, account login, credentials, external send or deployment.", checks: [], input: { fixtureOnly: true, domTextVerified: false }, files: [], result: "running" };
  const check = (name) => { report.checks.push(name); process.stdout.write(`PASS ${name}\n`); };
  let allocated = false;
  try {
    const inspected = JSON.parse(await command(["image", "inspect", image])); assert(inspected.length === 1, "Local image is ambiguous");
    const metadata = inspected[0]; assert(/^sha256:[a-f0-9]{64}$/.test(metadata.Id), "Immutable local image ID missing");
    assert(!Object.keys(metadata.Config?.ExposedPorts ?? {}).length && !Object.keys(metadata.Config?.Volumes ?? {}).length, "Image exposes a port or volume");
    for (const entry of metadata.Config?.Env ?? []) assert(/^(PATH|LANG|LC_ALL|TZ|DEBIAN_FRONTEND)=/.test(entry), "Unexpected image environment; no runtime started");
    report.imageId = metadata.Id; report.dockerfileSha256 = HASH(await readFile(new URL("../Dockerfile.computer", import.meta.url))); check("Existing image resolved to immutable local ID with no ports/volumes/credential environment");
    const expiresAt = Date.now() + 60000; report.expiresAt = expiresAt;
    allocated = true; // cleanup also covers a lost `docker run` acknowledgment
    await command(runtimeArguments(name, metadata.Id, expiresAt), { timeoutMs: 15000 });
    const host = JSON.parse(await command(["inspect", "--format", "{{json .HostConfig}}", name]));
    assert(host.NetworkMode === "none" && host.ReadonlyRootfs && !host.Privileged && !host.Binds?.length && !Object.keys(host.PortBindings ?? {}).length, "Offline/no-host-access configuration changed");
    assert(host.Memory === 1073741824 && host.NanoCpus === 500000000 && host.PidsLimit === 256 && host.CapDrop?.includes("ALL"), "Runtime resource bounds changed");
    const actualEnv = JSON.parse(await command(["inspect", "--format", "{{json .Config.Env}}", name]));
    for (const entry of actualEnv) { const [key, ...parts] = entry.split("="); assert(["PATH", "LANG", "LC_ALL", "TZ", "DEBIAN_FRONTEND", "SHIBA_COMPUTER_EXPIRES_AT", ...PROXIES].includes(key), "Unexpected runtime environment"); if (PROXIES.includes(key)) assert(parts.join("=") === "", "Runtime proxy injection detected"); }
    report.runtime = { network: "none", cpus: 0.5, memoryBytes: host.Memory, pids: host.PidsLimit, readOnly: true, hostMounts: 0, publishedPorts: 0, proxyEnvironmentEmpty: true }; check("Runtime has zero external network, host bind mounts, published ports or proxy credentials and fixed resource/PID bounds");
    await command(["exec", name, "/usr/local/bin/shiba-computer-ready"], { timeoutMs: 20000 }); check("Real X display and visible Chromium window pass readiness");
    const windowId = (await command(["exec", "--env", "DISPLAY=:1", name, "xdotool", "search", "--onlyvisible", "--class", "[Cc]hromium"])).trim().split(/\s+/)[0];
    assert(/^\d+$/.test(windowId), "No exact desktop window available");
    await command(["exec", "--env", "DISPLAY=:1", name, "xdotool", "windowactivate", "--sync", windowId]);
    const capture = async (filename) => {
      await command(["exec", "--env", "DISPLAY=:1", name, "scrot", "--overwrite", "--pointer", "--quality", "60", "/tmp/shiba-computer.jpg"]);
      const data = await command(["exec", name, "cat", "/tmp/shiba-computer.jpg"], { binary: true, maxBytes: 524288 });
      assert(data.byteLength >= 4 && data[0] === 255 && data[1] === 216 && data.at(-2) === 255 && data.at(-1) === 217, "JPEG is incomplete or unavailable");
      await writeFile(resolve(destination, filename), data, { mode: 0o600 }); report.files.push({ filename, bytes: data.byteLength, sha256: HASH(data) }); return data;
    };
    const before = await capture("before.jpg");
    await command(["exec", "--env", "DISPLAY=:1", name, "xdotool", "mousemove", "--sync", "256", "360", "click", "1"]);
    const literal = "SHIBA OFFLINE INPUT ACCEPTANCE - literal fixture text, no shell or external action. ".repeat(8);
    await command(["exec", "--env", "DISPLAY=:1", name, "xdotool", "type", "--clearmodifiers", "--delay", "0", "--", literal]);
    // The image is inspected visually via this artifact. Byte/raster changes
    // do not independently certify DOM contents or business outcomes.
    const after = await capture("after.jpg"); assert(HASH(before) !== HASH(after), "Display did not change after real literal typing");
    report.input = { fixtureOnly: true, attemptedUtf8Bytes: Buffer.byteLength(literal), cliAcknowledged: true, jpegChanged: true, domTextVerified: false };
    check("Real xdotool literal input completes and bounded JPEG changes; artifacts retained for visual verification");
    const packages = await command(["exec", name, "cat", "/usr/share/shiba-computer/packages.tsv"]); await writeFile(resolve(destination, "packages.tsv"), packages, { mode: 0o600 }); report.packageManifestSha256 = HASH(packages);
    await command(["exec", name, "sh", "-c", "test -s /usr/share/shiba-computer/licenses/cloudflare-sandbox/LICENSE-sandbox && test -s /usr/share/shiba-computer/licenses/cloudflare-sandbox/NOTICE && for p in xvfb xserver-common openbox chromium chromium-common xdotool libxdo3 scrot; do test -s /usr/share/shiba-computer/licenses/$p/copyright || exit 1; done"]); check("Installed package manifest and actual bundled license notices exist");
    const until = expiresAt + 15000;
    while (Date.now() < until) { if ((await command(["inspect", "--format", "{{.State.Running}}", name])).trim() === "false") break; await new Promise((resolveWait) => setTimeout(resolveWait, 500)); }
    assert((await command(["inspect", "--format", "{{.State.Running}}", name])).trim() === "false", "Fixed desktop watchdog did not terminate runtime");
    assert((await command(["inspect", "--format", "{{.State.ExitCode}}", name])).trim() === "0", "Desktop exited without a successful expiry watchdog"); check("Fixed expiry watchdog stops the actual desktop without a heartbeat extension");
    report.result = "pass";
  } catch (error) { report.result = "fail"; report.error = error instanceof Error ? error.message : "Local acceptance failed"; throw error; }
  finally {
    if (allocated) { try { await command(["rm", "--force", name], { timeoutMs: 15000 }); report.cleanup = "owned-container-removed"; } catch { report.cleanup = "owned-container-removal-unconfirmed"; report.result = "fail"; } }
    report.finishedAt = new Date().toISOString(); await writeFile(resolve(destination, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  }
  if (report.result !== "pass") throw new Error("Owned local computer cleanup is unconfirmed"); return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { const { values } = parseArgs({ options: { image: { type: "string" }, output: { type: "string" } }, strict: true, allowPositionals: false });
    await verifyOfflineComputer({ image: values.image, output: values.output ?? `/tmp/shiba-computer-evidence-${randomUUID()}` });
  } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : "Local offline acceptance failed"}\n`); process.exitCode = 1; }
}
