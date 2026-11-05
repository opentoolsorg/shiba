import assert from "node:assert/strict";
import { test } from "node:test";
import { runtimeArguments, dockerEnvironment } from "./verify-offline.mjs";
const name = `shiba-computer-acceptance-${"a".repeat(32)}`, image = `sha256:${"b".repeat(64)}`;
test("offline acceptance uses immutable local image with bounded private runtime and no host access", () => {
  const args = runtimeArguments(name, image, 12345);
  for (const field of ["--pull=never", "--network=none", "--read-only", "--cpus=0.5", "--memory=1g", "--pids-limit=256", "--cap-drop=ALL"]) assert(args.includes(field));
  assert.equal(args.at(-1), image); assert(!args.some((arg) => /^(?:-p|--publish|--mount|--volume|--network=host)/.test(arg))); assert(!args.some((arg) => /API_KEY|TOKEN|SIGNING_KEY|SECRET/.test(arg)));
});
test("runtime does not inherit Docker client proxy credentials", () => {
  const args = runtimeArguments(name, image, 12345);
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "FTP_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "ftp_proxy"]) assert(args.includes(`${key}=`));
});
test("daemon endpoint/TLS selectors cannot redirect the acceptance to a remote Docker host", () => {
  const env = dockerEnvironment({ DOCKER_HOST: "remote", DOCKER_CONTEXT: "other", DOCKER_TLS: "1", DOCKER_TLS_VERIFY: "1", DOCKER_CERT_PATH: "other", DOCKER_CONFIG: "preserved", HTTPS_PROXY: "preserved-build-proxy" });
  for (const key of ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"]) assert.equal(env[key], undefined);
  assert.equal(env.DOCKER_CONFIG, "preserved"); assert.equal(env.HTTPS_PROXY, "preserved-build-proxy");
});
for (const [label, container, id] of [["foreign container", "existing-container", image], ["mutable image", name, "image:latest"], ["argument injection", name, "--privileged"]]) test(`rejects ${label} before spawning`, () => assert.throws(() => runtimeArguments(container, id, 12345)));
