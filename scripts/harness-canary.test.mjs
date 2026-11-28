import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { evaluate, githubIssues, recordVerdict } from "./harness-canary-incidents.mjs";
import { imageInputHash, probeImage, probeModels } from "./harness-canary-probe.mjs";

const digest = `registry.example.test/shiba/canary@sha256:${"e".repeat(64)}`;
const revision = "f".repeat(40);
const bot = { login: "github-actions[bot]", type: "Bot" };
const keys = Object.fromEntries(["OPENAI", "ANTHROPIC", "GOOGLE", "XAI"].map((name) => [
  `SHIBA_CANARY_${name}_KEY`, `fake-${name}-not-a-credential`,
]));
const paths = new Map([
  ["https://api.anthropic.com/v1/models/claude-sonnet-4-6", "anthropic/claude-sonnet-4-6"],
  ["https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash", "google/gemini-3.5-flash"],
  ["https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite", "google/gemini-3.5-flash-lite"],
  ["https://api.openai.com/v1/models/gpt-5.3-codex", "openai/gpt-5.3-codex"],
  ["https://api.x.ai/v1/models/grok-4.6", "xai/grok-4.6"],
]);
const verdicts = ["passed", "failed", "inconclusive"];
const initial = () => ({ version: 1, lastRun: 0, verdict: null, streak: 0, firstFailure: null, incident: null });
const hit = (url) => {
  const [provider, id] = paths.get(url).split("/");
  return Response.json(provider === "google" ? { name: `models/${id}`, supportedGenerationMethods: ["generateContent"] } : { id });
};

function fixture() {
  let ledger = initial();
  const issues = new Map();
  const mutations = [];
  const closed = new Set();
  const api = {
    botLogin: bot.login,
    readLedger: async () => structuredClone(ledger),
    saveLedger: async (state) => { ledger = structuredClone(state); },
    getIssue: async (number) => issues.get(number),
    listIssues: async () => [...issues.values()],
    wasClosed: async (number) => closed.has(number),
    createIssue: async (payload) => {
      const number = issues.size + 1;
      assert.equal(ledger.incident.phase, "opening");
      mutations.push(["create", number]);
      const issue = { ...payload, number, state: "open", user: bot };
      issues.set(number, issue);
      return issue;
    },
    closeIssue: async (number) => {
      assert.equal(ledger.incident.phase, "closing");
      mutations.push(["close", number]);
      closed.add(number);
      const issue = issues.get(number);
      issue.state = "closed";
      return issue;
    },
  };
  const record = (run, verdict) => recordVerdict(api, { run, verdict });
  return { api, issues, mutations, closed, record };
}

test("image access requires the pinned source and digest, never pulls, and runs without network or credentials", () => {
  const env = { SHIBA_CANARY_IMAGE: digest, SHIBA_CANARY_IMAGE_INPUTS_SHA256: imageInputHash(), ...keys };
  let calls = 0;
  const docker = (bin, args, options) => {
    assert.equal(bin, "docker");
    assert.deepEqual(Object.keys(options.env).sort(), ["HOME", "PATH"]);
    calls++;
    if (args[0] === "image") return { status: 0, stdout: `linux/amd64 ${JSON.stringify([digest])}\n` };
    for (const flag of ["--pull=never", "--read-only", "--cap-drop", "--security-opt", digest]) assert.ok(args.includes(flag));
    assert.deepEqual(args.slice(args.indexOf("--network"), args.indexOf("--network") + 2), ["--network", "none"]);
    assert.ok(args.includes("@openai/codex=codex=0.157.1"));
    assert.equal(options.timeout, 90_000);
    return { status: 0 };
  };
  assert.equal(probeImage(env, docker).status, "passed");
  assert.equal(calls, 2);
  assert.equal(probeImage({ ...env, SHIBA_CANARY_IMAGE: "shiba:latest" }, docker).status, "inconclusive");
  assert.equal(probeImage({ ...env, SHIBA_CANARY_IMAGE_INPUTS_SHA256: "f".repeat(64) }, docker).status, "inconclusive");
  assert.equal(calls, 2);
  assert.equal(probeImage(env, () => ({ status: 0, stdout: `linux/arm64 ["${digest}"]` })).reason, "unverified-image-pin");
  assert.equal(probeImage(env, () => ({ status: 1 })).reason, "image-not-preloaded");
});

test("timed-out image probe attempts bounded container cleanup and retains a failure", () => {
  let name;
  const report = probeImage({ SHIBA_CANARY_IMAGE: digest, SHIBA_CANARY_IMAGE_INPUTS_SHA256: imageInputHash() }, (_bin, args, options) => {
    if (args[0] === "image") return { status: 0, stdout: `linux/amd64 ["${digest}"]` };
    if (args[0] === "run") {
      name = args[args.indexOf("--name") + 1];
      return { status: null, error: { code: "ETIMEDOUT" } };
    }
    assert.deepEqual(args, ["rm", "-f", name]);
    assert.equal(options.timeout, 5_000);
    return { status: 0 };
  });
  assert.deepEqual(report, { status: "failed", reason: "image-probe-timeout" });
});

test("a missing binary in an inspected image is a failure, not a skipped probe", () => {
  const report = probeImage({ SHIBA_CANARY_IMAGE: digest, SHIBA_CANARY_IMAGE_INPUTS_SHA256: imageInputHash() }, (_bin, args) =>
    args[0] === "image" ? { status: 0, stdout: `linux/amd64 ["${digest}"]` } : { status: 127 },
  );
  assert.deepEqual(report, { status: "failed", reason: "cli-pin-or-startup-mismatch" });
});

test("probes only exact metadata IDs using one credential per documented host and no retries", async () => {
  const called = [];
  const results = await probeModels(keys, (url, options) => {
    called.push(url);
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    const [provider] = paths.get(url).split("/");
    const key = keys[`SHIBA_CANARY_${provider.toUpperCase()}_KEY`];
    assert.equal(Object.values(options.headers).filter((value) => value.includes("not-a-credential")).length, 1);
    assert.equal(options.headers["x-api-key"] ?? options.headers["x-goog-api-key"] ?? options.headers.Authorization,
      provider === "google" || provider === "anthropic" ? key : `Bearer ${key}`);
    return hit(url);
  });
  assert.deepEqual(called.sort(), [...paths.keys()].sort());
  assert.deepEqual(Object.keys(results).sort(), [...paths.values()].sort());
  assert.ok(Object.values(results).every(({ status }) => status === "passed"));
  assert.doesNotMatch(JSON.stringify(results), /not-a-credential/);
});

test("distinguishes missing, auth, rate limit, transport, malformed, unsupported and timeout without a false pass", async () => {
  const model = "openai/gpt-5.3-codex";
  const cases = [
    [() => new Response("fake-secret", { status: 404 }), "model-not-visible"],
    [() => new Response("fake-secret", { status: 403 }), "metadata-auth-denied"],
    [() => new Response("fake-secret", { status: 429, headers: { "Retry-After": "600" } }), "metadata-rate-limited"],
    [() => new Response(null, { status: 503 }), "metadata-http-failure"],
    [() => new Response(null, { status: 302, headers: { Location: "https://redirect.invalid/" } }), "metadata-http-failure"],
    [() => new Response(null, { status: 204 }), "metadata-http-failure"],
    [() => Response.json({ id: "gpt-5.3-codex-preview", aliases: ["gpt-5.3-codex"] }), "invalid-model-metadata"],
    [() => new Response("{}x"), "invalid-model-metadata"],
    [() => Response.json({ id: "gpt-5.3-codex", body: "x".repeat(260 * 1024) }), "invalid-model-metadata"],
    [() => { throw new Error("fake-secret"); }, "metadata-transport-failure"],
    [(_url, { signal }) => delay(1_000, null, { signal }), "metadata-timeout"],
  ];
  for (const [response, reason] of cases) {
    let attempted = 0;
    const results = await probeModels({ SHIBA_CANARY_OPENAI_KEY: keys.SHIBA_CANARY_OPENAI_KEY }, (url, options) => {
      assert.equal(paths.get(url), model);
      attempted++;
      return response(url, options);
    }, 20);
    assert.deepEqual(results[model], { status: "failed", reason });
    assert.equal(attempted, 1);
    assert.equal(results["xai/grok-4.6"].status, "inconclusive");
    assert.doesNotMatch(JSON.stringify(results), /fake-secret/);
  }
  const methods = await probeModels({ SHIBA_CANARY_GOOGLE_KEY: keys.SHIBA_CANARY_GOOGLE_KEY }, (url) => {
    const [, id] = paths.get(url).split("/");
    return Response.json({ name: `models/${id}`, supportedGenerationMethods: ["embedContent"] });
  });
  assert.equal(methods["google/gemini-3.5-flash"].reason, "model-capability-unavailable");
});

test("version-only, absent, stale, wrong input, extra and incomplete evidence cannot pass", () => {
  const run = 123;
  const scoped = (evidence) => ({ revision, run, evidence });
  const evidence = {
    revision, run, conformance: "passed",
    image: scoped({ status: "passed", reason: "pinned-clis-present", image: digest, inputsSha256: imageInputHash() }),
    models: scoped(Object.fromEntries([...paths.values()].map((id) => [id, { status: "passed", reason: "exact-model-visible" }]))),
  };
  assert.equal(evaluate(evidence).verdict, "passed");
  for (const change of [
    { conformance: "" }, { models: null }, { models: scoped({}) }, { models: { ...evidence.models, run: run - 1 } },
    { image: { ...evidence.image, revision: "0".repeat(40) } },
    { image: scoped({ ...evidence.image.evidence, inputsSha256: "8".repeat(64) }) },
    { image: scoped({ ...evidence.image.evidence, status: "failed", reason: "metadata-auth-denied" }) },
    { image: scoped({ status: "failed", reason: "cli-pin-or-startup-mismatch", image: digest }) },
    { models: scoped({ ...evidence.models.evidence, unexpected: {} }) },
  ]) assert.equal(evaluate({ ...evidence, ...change }).verdict, "inconclusive");
  assert.equal(evaluate({ ...evidence, conformance: "failed" }).verdict, "failed");
  assert.equal(evaluate({ ...evidence, image: scoped({
    ...evidence.image.evidence, status: "failed", reason: "image-probe-timeout",
  }) }).verdict, "failed");
  assert.equal(evaluate({ ...evidence, models: scoped({
    ...evidence.models.evidence, "xai/grok-4.6": { status: "failed", reason: "metadata-rate-limited" },
  }) }).verdict, "failed");
});

test("one incident on the second failure, no duplicate on sustain/replay, one close after recovery", async () => {
  const { record, mutations, issues, api } = fixture();
  let state = await record(3, "failed");
  assert.equal(state.streak, 1);
  assert.deepEqual(mutations, []);
  state = await record(4, "failed");
  assert.deepEqual(state.incident, { generation: 3, number: 1, phase: "open" });
  assert.match(issues.get(1).body, /^<!-- shiba-harness-canary:v1:3 -->/);
  await record(4, "passed");
  await record(5, "failed");
  await record(6, "inconclusive");
  await record(2, "passed");
  assert.deepEqual(mutations, [["create", 1]]);
  issues.set(91, { number: 91, body: issues.get(1).body, state: "open", user: { id: 77, type: "User" } });
  await record(7, "passed");
  await record(8, "passed");
  assert.deepEqual(mutations, [["create", 1], ["close", 1]]);
  assert.equal(issues.get(91).state, "open");
  assert.equal((await api.readLedger()).streak, 0);
});

test("success, gaps, and inconclusive samples break consecutive failures", async () => {
  for (const reset of [undefined, ...verdicts.filter((v) => v !== "failed")]) {
    const { record, mutations } = fixture();
    await record(1, "failed");
    if (reset) await record(2, reset);
    assert.equal((await record(3, "failed")).streak, 1);
    assert.deepEqual(mutations, []);
  }
});

test("human close resets the streak; close then reopen still leaves the human's issue alone", async () => {
  for (const reopen of [false, true]) {
    const { record, issues, mutations, closed } = fixture();
    await record(10, "failed");
    await record(11, "failed");
    issues.get(1).state = reopen ? "open" : "closed";
    closed.add(1);
    assert.equal((await record(12, "failed")).streak, 1);
    assert.deepEqual(mutations, [["create", 1]]);
    const state = await record(13, "failed");
    assert.equal(state.incident.generation, 12);
    await record(14, "passed");
    assert.deepEqual(mutations, [["create", 1], ["create", 2], ["close", 2]]);
    assert.equal(issues.get(1).state, reopen ? "open" : "closed");
  }
});

test("lost create responses adopt the original bot issue, not a human lookalike or a second POST", async () => {
  const { record, api, issues, mutations } = fixture();
  const create = api.createIssue;
  const list = api.listIssues;
  api.createIssue = async (payload) => {
    await create(payload);
    throw new Error("lost response");
  };
  await record(1, "failed");
  await assert.rejects(record(2, "failed"), /lost response/);
  issues.set(91, { ...issues.get(1), number: 91, user: { id: 91, type: "User" } });
  api.listIssues = async () => [issues.get(91)];
  await assert.rejects(record(2, "failed"), /create is unresolved/);
  api.listIssues = list;
  assert.equal((await record(2, "failed")).incident.number, 1);
  assert.deepEqual(mutations, [["create", 1]]);
});

test("ambiguous ledger-write acknowledgement never allows an unjournaled POST or automatic second attempt", async () => {
  const { record, api, mutations } = fixture();
  const save = api.saveLedger;
  await record(1, "failed");
  api.saveLedger = async (state) => {
    await save(state);
    throw new Error("lost ledger acknowledgement");
  };
  await assert.rejects(record(2, "failed"), /lost ledger acknowledgement/);
  api.saveLedger = save;
  await assert.rejects(record(3, "failed"), /create is unresolved/);
  assert.deepEqual(mutations, []);
});

test("failed recovery retries only the matching bot issue and detects a lost close response", async () => {
  const { record, api, mutations, issues } = fixture();
  await record(1, "failed");
  await record(2, "failed");
  const close = api.closeIssue;
  api.closeIssue = async () => { throw new Error("429 before close"); };
  await assert.rejects(record(3, "passed"), /429 before close/);
  api.closeIssue = async (number) => {
    await close(number);
    throw new Error("lost close response");
  };
  await assert.rejects(record(3, "passed"), /lost close response/);
  assert.equal((await record(3, "passed")).incident, null);
  await record(4, "failed");
  await record(5, "failed");
  issues.get(2).user = { ...bot, login: "another-bot[bot]" };
  await assert.rejects(record(6, "passed"), /identity no longer matches/);
  assert.deepEqual(mutations, [["create", 1], ["close", 1], ["create", 2]]);
});

test("GitHub adapter is isolated, handles pagination, and never retries a mutation on HTTP errors", async () => {
  const config = {
    SHIBA_CANARY_SOURCE_REPO: "shiba-test/isolated-incidents",
    SHIBA_CANARY_ISSUES_TOKEN: "fake-fixture-token",
    SHIBA_CANARY_LEDGER_ISSUE: "7", GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "shiba-test/isolated-incidents",
  };
  for (const change of [
    { GITHUB_ACTIONS: "false" },
    { GITHUB_REPOSITORY: "shiba-test/another-repo" },
    { GITHUB_REPOSITORY: "opentoolsorg/shiba", SHIBA_CANARY_SOURCE_REPO: "opentoolsorg/shiba" },
  ]) assert.throws(() => githubIssues({ ...config, ...change }), /isolated Actions repository/);
  const requests = [];
  const api = githubIssues(config, (url, options) => {
    requests.push([url, options.method]);
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, "Bearer fake-fixture-token");
    if (options.method === "POST") return new Response("fake-fixture-token", { status: 429 });
    if (new URL(url).searchParams.get("page") === "1") return Response.json([], { headers: { Link: '<https://ignored.invalid/>; rel="next"' } });
    return Response.json([{ event: "closed" }]);
  });
  assert.equal(await api.wasClosed(17), true);
  await assert.rejects(api.createIssue({}), (error) => {
    assert.doesNotMatch(error.message, /fake-fixture-token/);
    return /POST failed/.test(error.message);
  });
  assert.deepEqual(requests.map(([url, method]) => [new URL(url).hostname, method]), [
    ["api.github.com", "GET"], ["api.github.com", "GET"], ["api.github.com", "POST"],
  ]);
});

test("workflow stays undiscoverable, takes no PR inputs and only allows the protected dispatch branch", () => {
  const draft = new URL("../.github/workflows/harness-canary.yml.disabled", import.meta.url);
  const workflow = readFileSync(draft, "utf8");
  assert.equal(existsSync(new URL("harness-canary.yml", draft)), false);
  assert.doesNotMatch(workflow, /(^|\s)(pull_request(?:_target)?|schedule|push)\s*:/m);
  assert.equal([...workflow.matchAll(/github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main'/g)].length, 5);
  assert.equal([...workflow.matchAll(/SHIBA_CANARY_ENABLED == 'true'/g)].length, 5);
  assert.equal([...workflow.matchAll(/github\.repository != 'opentoolsorg\/shiba'/g)].length, 5);
  assert.equal([...workflow.matchAll(/issues: write/g)].length, 1);
  assert.match(workflow, /SHIBA_CANARY_ISSUES_TOKEN: \$\{\{ github\.token \}\}/);
  assert.doesNotMatch(workflow, /--maxWorkers=2\s+\+/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.doesNotMatch(workflow, /actions\/cache|docker pull|wrangler deploy/);
  assert.ok(workflow.indexOf("actions/upload-artifact") < workflow.indexOf("SHIBA_CANARY_ISSUES_TOKEN"));
});
