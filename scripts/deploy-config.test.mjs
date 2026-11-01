import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { deploymentConfig } from "../deploy-config.ts";

const account = "0".repeat(32);
const preview = { isLiveStage: false, workerName: "shiba-ai-coworker-pr-162", liveHost: "app.example.com" };
const env = { CLOUDFLARE_ACCOUNT_ID: account, ALCHEMY_STAGE: "pr-162", WORKERS_SUBDOMAIN: "example", ACCESS_EMAILS: "owner@example.com" };
const host = "shiba-ai-coworker-pr-162.example.workers.dev";

test("preview uses its own hostname and managed Access", () => {
  assert.deepEqual(deploymentConfig(env, preview), {
    workerHost: host, accessEnabled: true, accessEmails: ["owner@example.com"],
  });
});

test("public previews support the existing built-in auth lane with either bootstrap gate", () => {
  for (const bootstrap of [{ BETTER_AUTH_OWNER_EMAIL: "owner@example.com" }, { BETTER_AUTH_BOOTSTRAP_TOKEN: "setup-token" }]) {
    assert.equal(deploymentConfig({ ...env, ACCESS_EMAILS: "", BETTER_AUTH_SECRET: "s".repeat(32), ...bootstrap }, preview).accessEnabled, false);
  }
});

test("reject unsafe account, host, auth and inherited production overrides", () => {
  for (const override of [
    { CLOUDFLARE_ACCOUNT_ID: undefined },
    { CLOUDFLARE_ACCOUNT_ID: "wrong" },
    { SANDBOX_IMAGE: `registry.cloudflare.com/${"1".repeat(32)}/sandbox:latest` },
    { SANDBOX_IMAGE: `registry.cloudflare.com/${account}.evil/sandbox:latest` },
    { WORKERS_SUBDOMAIN: undefined },
    { WORKERS_SUBDOMAIN: "example.workers.dev" },
    { WORKERS_SUBDOMAIN: "example/path" },
    { WORKER_HOSTNAME: "app.example.com" },
    { BETTER_AUTH_URL: "https://app.example.com" },
    { BETTER_AUTH_URL: `https://${host}/` },
    { ACCESS_AUD: "inherited-audience" },
    { REQUIRE_ACCESS: "0" },
    { ACCESS_EMAILS: "" },
    { ACCESS_EMAILS: "", REQUIRE_ACCESS: "1" },
    { ACCESS_EMAILS: "", BETTER_AUTH_SECRET: "s".repeat(32) },
    { BETTER_AUTH_SECRET: "short" },
    { ACCESS_EMAILS: "not-an-email" },
    { BETTER_AUTH_OWNER_EMAIL: "not-an-email" },
    { ALCHEMY_STAGE: "" },
    { ALCHEMY_STAGE: "live_backup" },
  ]) assert.throws(() => deploymentConfig({ ...env, ...override }, preview));
});

test("live requires explicit custom host and puts Access on that host", () => {
  const live = { ...preview, isLiveStage: true, workerName: "shiba-ai-coworker" };
  assert.throws(() => deploymentConfig({ ...env, ALCHEMY_STAGE: "live" }, live), /explicit WORKER_HOSTNAME/);
  assert.equal(deploymentConfig({ ...env, ALCHEMY_STAGE: "live", WORKER_HOSTNAME: "app.example.com", WORKERS_SUBDOMAIN: undefined }, live).workerHost, "app.example.com");
  assert.equal(deploymentConfig({ ...env, SANDBOX_IMAGE: `registry.cloudflare.com/${account}/sandbox:latest` }, preview).workerHost, host);
});

test("Alchemy protects validated stage origins from override spreads", () => {
  const stack = readFileSync(new URL("../alchemy.run.ts", import.meta.url), "utf8");
  const configVars = stack.match(/\.\.\.configVars\(\[([\s\S]*?)\]\)/)?.[1];
  assert.ok(configVars);
  for (const name of ["BETTER_AUTH_URL", "WORKER_HOSTNAME", "REQUIRE_ACCESS", "ACCESS_AUD"]) {
    assert.ok(!configVars.includes(`"${name}"`), `${name} must not override validation`);
  }
  assert.ok(stack.includes('BETTER_AUTH_URL: isLiveStage ? "https://app.tryshiba.dev" : workerOrigin'));
  assert.match(stack, /const workerOrigin = `https:\/\/\$\{workerHost\}`/);
  assert.match(stack, /const LIVE_STAGE = \/\^live\$\//);
  assert.match(stack, /uri: workerHost as string/);
  assert.match(stack, /enabled: true, previewsEnabled: false/);
  assert.ok(stack.indexOf("= deploymentConfig(") < stack.indexOf('Cloudflare.Access.Application("'));
});
