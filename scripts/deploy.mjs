#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { validateContext, validatePlan, proveExistingTargets } from "./preview-guard.mjs";
import { inspectAssets, verifyHttpBuildAt } from "./preview-update-existing.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
export function options(args, env) {
  if (args.filter((a) => a.startsWith("--stage=")).length > 1 || (args.includes("--destroy") && args.some((a) => ["--plan", "--dry-run"].includes(a)))) throw new Error("Conflicting deploy arguments");
  const stage = args.find((a) => a.startsWith("--stage="))?.slice(8) ?? env.ALCHEMY_STAGE ?? "live";
  if (!/^(prod|live|dogfood|pr-[1-9]\d*)$/.test(stage)) throw new Error("Use --stage=prod|dogfood|pr-<number>");
  if (args.some((a) => !a.startsWith("--stage=") && !["--destroy", "--plan", "--dry-run", "--wrangler"].includes(a))) throw new Error("Unknown deploy argument");
  const operation = args.includes("--destroy") ? "destroy" : args.includes("--plan") || args.includes("--dry-run") ? "plan" : "deploy";
  if (operation === "destroy" && (!args.some((a) => a.startsWith("--stage=")) && !env.ALCHEMY_STAGE)) throw new Error("Destroy requires an explicit stage");
  if (args.includes("--wrangler") && (stage.startsWith("pr-") || operation === "destroy")) throw new Error("Wrangler fallback is live/dogfood deploy or plan only");
  return { stage: stage === "prod" ? "live" : stage, operation };
}
export function normalizePlanValue(v, runtime, key = "") {
  const { Output, Resource, Redacted, Effect } = runtime;
  const normalize = (x, k = key) => normalizePlanValue(x, runtime, k);
  if (Resource.isResource(v)) return { $resource: v.FQN };
  if (Output.isOutput(v)) {
    if (Output.isResourceExpr(v)) return { $resource: v.src.FQN };
    if (Output.isPropExpr(v)) return normalize(v.expr);
    if (Output.isApplyExpr(v) && ["jurisdiction", "hash"].includes(key)) return normalize(v.expr);
    if (Output.isApplyExpr(v) && key === "namespaceId" && Output.isPropExpr(v.expr) && v.expr.identifier === "durableObjectNamespaces") return normalize(v.expr);
    throw new Error("Unreviewed computed binding target");
  }
  if (Redacted.isRedacted(v)) return { $secret: true };
  if (Effect.isEffect(v)) return { $declaration: true };
  if (Array.isArray(v)) return v.map((x) => normalize(x));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x !== "function" || Output.isOutput(x)).map(([k, x]) => [k, normalize(x, k)]));
  return v;
}
function command(cmd, args, env = process.env) {
  const result = spawnSync(cmd, args, { cwd: root, env, encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(`${cmd} failed: ${result.stderr ?? result.error}`);
  return result.stdout.trim();
}

export async function main(args = process.argv.slice(2)) {
  const { stage, operation } = options(args, process.env);
  const preview = stage.startsWith("pr-");
  let assetFingerprint;
  process.env.ALCHEMY_STAGE = stage;
  if (preview) {
    if (process.env.ALCHEMY_STATE_BACKEND !== "cloudflare") throw new Error("Preview requires existing remote Alchemy state");
    if (!process.env.CLOUDFLARE_API_TOKEN) throw new Error("Missing preview API token");
    if (operation !== "destroy" && (!process.env.BETTER_AUTH_SECRET || !process.env.BETTER_AUTH_OWNER_EMAIL)) throw new Error("Preview requires dedicated auth secret and owner email");
    if (readFileSync(new URL("../package.json", import.meta.url), "utf8").includes('"alchemy": "2.0.0-beta.80"') === false) throw new Error("Review guard before upgrading Alchemy");
  }
  const context = () => ({ stage, operation, account: process.env.CLOUDFLARE_ACCOUNT_ID,
    expectedAccount: process.env.PREVIEW_ACCOUNT_ID, head: process.env.EXPECTED_HEAD,
    checkout: command("git", ["rev-parse", "HEAD"]), repository: process.env.GITHUB_REPOSITORY,
    pr: JSON.parse(command("gh", ["pr", "view", stage.slice(3), "--repo", process.env.GITHUB_REPOSITORY,
      "--json", "number,state,headRefOid,headRepository,labels"])) });
  if (preview) validateContext(context());
  if (operation === "deploy") {
    // Build without deployment or application credentials, just as in CI.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(PATH|HOME|CI|TMPDIR|NODE_OPTIONS|PNPM_HOME)$/.test(k)));
    console.log(command("pnpm", ["build"], env));
    if (preview) assetFingerprint = await inspectAssets(resolve(root, "app-public"));
  }
  if (args.includes("--wrangler")) {
    const config = stage === "dogfood" ? "apps/backend/wrangler.dogfood.jsonc" : "apps/backend/wrangler.jsonc";
    console.log(command("pnpm", ["exec", "wrangler", "deploy", "--config", config, ...(operation === "plan" ? ["--dry-run"] : [])]));
    return;
  }
  // Use the pinned CLI's TypeScript loader, including its .js-to-.ts resolution.
  await import(new URL("./register-oxc.js", import.meta.resolve("alchemy/bin/alchemy.js")).href);
  const [{ Effect, Redacted }, Alchemist, Output, Resource, Cloudflare] = await Promise.all([
    import("effect"), import("alchemy/Alchemist"), import("alchemy/Output"), import("alchemy/Resource"), import("alchemy/Cloudflare"),
  ]);
  const normalize = (v) => normalizePlanValue(v, { Output, Resource, Redacted, Effect });
  const api = async (path) => {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}${path}`, {
      headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` },
    });
    const body = await response.json();
    if (!response.ok || !body.success) throw new Error(`Preview ownership read failed: ${path}`);
    return body.result;
  };
  const program = Effect.gen(function* () {
    const snapshot = yield* Alchemist.Stack.plan({ target: { entrypoint: resolve(root, "alchemy.run.ts"), stage },
      operation: operation === "destroy" ? "destroy" : "deploy", adopt: false, updateStateStore: false });
    if (preview) {
      const resources = [...Object.values(snapshot.native.resources), ...Object.values(snapshot.native.deletions).filter(Boolean)].map((n) => ({
        fqn: n.resource.FQN, type: n.resource.Type, action: n.action,
        props: normalize(n.props ?? n.resource.Props), state: normalize(n.state), bindings: normalize(n.bindings),
      }));
      const configs = ["apps/backend/wrangler.jsonc", "apps/backend/wrangler.dogfood.jsonc"];
      const forbidden = configs.flatMap((f) => [...readFileSync(resolve(root, f), "utf8").matchAll(/(?:"(?:id|database_id|namespace_id)"\s*:\s*")([a-f0-9-]{32,36})"/g)].map((m) => m[1]));
      const resolved = yield* Cloudflare.CloudflareEnvironment.pipe(Effect.flatMap((env) => env), Effect.provide(snapshot.session.context));
      validateContext({ ...context(), account: resolved.accountId });
      if (snapshot.stack.stage !== stage || snapshot.stack.name !== "shiba-ai-coworker") throw new Error("Resolved Alchemy stack/stage mismatch");
      if (operation === "destroy" && resources.length === 0) { console.log("No preview resources to destroy"); return; }
      validatePlan({ stage, account: process.env.CLOUDFLARE_ACCOUNT_ID, resources,
        actions: [...snapshot.actions, ...Object.values(snapshot.native.actionDeletions ?? {})], operation, forbidden, head: process.env.EXPECTED_HEAD });
      const proof = yield* Effect.promise(() => proveExistingTargets(resources, api));
      validateContext(context());
      if (operation !== "plan") assert.deepEqual(yield* Effect.promise(() => proveExistingTargets(resources, api)), proof, "Remote preview changed during preflight; refusing apply");
      if (operation === "deploy") assert.equal(yield* Effect.promise(() => inspectAssets(resolve(root, "app-public"))), assetFingerprint, "Build assets changed during preflight");
    }
    if (operation === "plan") { console.log(JSON.stringify(snapshot.summary)); return; }
    const result = yield* Alchemist.Stack.apply(snapshot);
    if (preview && operation === "deploy") {
      const origin = `https://shiba-ai-coworker-${stage}.${process.env.WORKERS_SUBDOMAIN}.workers.dev`;
      assert.equal(result.url, origin, "Deployed preview origin mismatch");
      const settings = yield* Effect.promise(() => api(`/workers/scripts/shiba-ai-coworker-${stage}/settings`));
      assert.equal(settings.bindings?.find((b) => b.name === "SHIBA_PREVIEW_COMMIT")?.text, process.env.EXPECTED_HEAD, "Deployed preview commit mismatch");
      yield* Effect.promise(() => verifyHttpBuildAt(resolve(root, "app-public"), origin));
    }
    console.log(JSON.stringify(result));
  });
  await Effect.runPromise(program.pipe(Effect.provide(Alchemist.layer()), Effect.scoped));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
