import assert from "node:assert/strict";
import { test } from "node:test";
import { validateContext, validatePlan, proveExistingTargets, identities } from "./preview-guard.mjs";

const account = "a".repeat(32), head = "b".repeat(40), stage = "pr-277";
const context = () => ({ stage, account, expectedAccount: account, head, checkout: head,
  repository: "owner/repo", operation: "deploy", pr: { number: 277, state: "OPEN", labels: [{ name: "preview:deploy" }], headRefOid: head, headRepository: { nameWithOwner: "owner/repo" } } });
const plan = () => ({ stage, account, head, operation: "deploy", resources: [
  { fqn: "Worker", type: "Cloudflare.Worker", action: "create", props: {
    name: `shiba-ai-coworker-${stage}`, crons: [], env: { SHIBA_PREVIEW_COMMIT: head, DB: { $resource: "DB" } },
  } },
  { fqn: "DB", type: "Cloudflare.D1Database", action: "create", props: { name: `shiba-audit-${stage}`, migrations: "./apps/backend/migrations" } },
] });

function consumerPlan() {
  const p = plan();
  p.resources.push(
    { fqn: "JOBS_QUEUE", type: "Cloudflare.Queues.Queue", action: "create", props: { name: `shiba-jobs-${stage}` } },
    { fqn: "JOBS_DLQ", type: "Cloudflare.Queues.Queue", action: "create", props: { name: `shiba-jobs-dlq-${stage}` } },
    { fqn: "JobsConsumer", type: "Cloudflare.Queues.Consumer", action: "create", props: { queueId: { $resource: "JOBS_QUEUE" }, scriptName: { $resource: "Worker" }, deadLetterQueue: { $resource: "JOBS_DLQ" }, settings: { batchSize: 1, maxRetries: 5 } } },
  );
  p.resources[0].bindings = [{ data: { bindings: [{ type: "queue", name: "JOBS_QUEUE", queueId: { $resource: "JOBS_QUEUE" }, queueName: { $resource: "JOBS_QUEUE" } }] } }];
  return p;
}
for (const [name, props, error] of [
  ["production script", { scriptName: "shiba-ai-coworker" }, /Consumer Worker/],
  ["unscoped dead-letter queue", { deadLetterQueue: "shiba-jobs-dlq" }, /Consumer dead-letter queue/],
  ["queue outside the plan", { queueId: { $resource: "PRODUCTION_QUEUE" } }, /Consumer queue/],
]) test(`consumer refuses ${name}`, () => {
  const p = consumerPlan(); Object.assign(p.resources.at(-1).props, props);
  assert.throws(() => validatePlan(p), error);
});
test("AR05 consumer and JOBS_QUEUE binding stay inside the preview graph", () => {
  const p = consumerPlan(); validatePlan(p);
  p.resources.at(-1).props.scriptName = `shiba-ai-coworker-${stage}`;
  p.resources.at(-1).props.deadLetterQueue = `shiba-jobs-dlq-${stage}`;
  validatePlan(p);
});

test("Consumer state and teardown cannot redirect to a different queue", () => {
  const p = consumerPlan(), queue = p.resources.find((r) => r.fqn === "JOBS_QUEUE"), consumer = p.resources.at(-1);
  queue.state = { status: "created", props: queue.props, attr: { accountId: account, queueId: "d".repeat(32), queueName: queue.props.name } };
  consumer.state = { status: "created", props: consumer.props, attr: { accountId: account, consumerId: "e".repeat(32), queueId: queue.state.attr.queueId, scriptName: `shiba-ai-coworker-${stage}`, deadLetterQueue: `shiba-jobs-dlq-${stage}` } };
  validatePlan(p);
  consumer.state.attr.queueId = "production"; assert.throws(() => validatePlan(p), /Consumer state queue/);
  consumer.state.attr.queueId = queue.state.attr.queueId;
  p.operation = "destroy"; consumer.props.queueId = queue.state.attr.queueId; validatePlan(p);
});
test("Consumer remote ownership must match its queue, Worker and dead-letter queue", async () => {
  const resources = [{ type: "Cloudflare.Queues.Consumer", state: { attr: { queueId: "queue", consumerId: "consumer", scriptName: `shiba-ai-coworker-${stage}`, deadLetterQueue: `shiba-jobs-dlq-${stage}` } } }];
  const response = { type: "worker", consumer_id: "consumer", script: `shiba-ai-coworker-${stage}`, dead_letter_queue: `shiba-jobs-dlq-${stage}` };
  const api = async (path) => { assert.equal(path, "/queues/queue/consumers/consumer"); return response; };
  await proveExistingTargets(resources, api);
  response.script = "production";
  await assert.rejects(proveExistingTargets(resources, api), /Consumer Worker ownership/);
});

test("any positive PR number has an isolated stage and exact open head", () => {
  for (const number of [1, 188, 277, 99999]) {
    const c = context(); c.stage = `pr-${number}`; c.pr.number = number;
    validateContext(c);
  }
});
for (const [name, mutate] of [
  ["unknown account", (c) => { c.account = "c".repeat(32); }],
  ["missing account allowlist", (c) => { delete c.expectedAccount; }],
  ["live stage", (c) => { c.stage = "live"; }],
  ["dogfood stage", (c) => { c.stage = "dogfood"; }],
  ["different PR stage", (c) => { c.stage = "pr-188"; }],
  ["malformed stage", (c) => { c.stage = "pr-277;rm"; }],
  ["fork", (c) => { c.pr.headRepository.nameWithOwner = "fork/repo"; }],
  ["removed opt-in label", (c) => { c.pr.labels = []; }],
  ["closed PR deployment", (c) => { c.pr.state = "CLOSED"; }],
  ["changed PR head", (c) => { c.pr.headRefOid = "c".repeat(40); }],
  ["wrong checkout", (c) => { c.checkout = "c".repeat(40); }],
]) test(`context refuses ${name}`, () => { const c = context(); mutate(c); assert.throws(() => validateContext(c)); });

test("teardown requires closed same-repo PR, not checkout of its untrusted head", () => {
  const c = context(); c.operation = "destroy"; c.pr.state = "CLOSED"; c.checkout = "default-branch";
  validateContext(c);
  c.pr.state = "MERGED"; validateContext(c);
  c.pr.state = "OPEN"; assert.throws(() => validateContext(c));
});

test("new preview graph and migrations are accepted", () => validatePlan(plan()));
for (const [name, mutate] of [
  ["production Worker", (p) => { p.resources[0].props.name = "shiba-ai-coworker"; }],
  ["dogfood D1", (p) => { p.resources[1].props.name = "shiba-audit-dogfood"; }],
  ["custom domain", (p) => { p.resources[0].props.domain = { name: "app.example.com" }; }],
  ["cron", (p) => { p.resources[0].props.crons = ["* * * * *"]; }],
  ["disabled auth", (p) => { p.resources[0].props.env.OPEN_DASHBOARD = "1"; }],
  ["Slack secrets", (p) => { p.resources[0].props.env.SLACK_BOT_TOKEN = { $secret: true }; }],
  ["wrong commit", (p) => { p.resources[0].props.env.SHIBA_PREVIEW_COMMIT = "d".repeat(40); }],
  ["missing commit", (p) => { delete p.resources[0].props.env.SHIBA_PREVIEW_COMMIT; }],
  ["missing migrations", (p) => { delete p.resources[1].props.migrations; }],
  ["clone of production data", (p) => { p.resources[1].props.clone = { name: "prod" }; }],
  ["import files", (p) => { p.resources[1].props.importFiles = ["dump.sql"]; }],
  ["external resource ref", (p) => { p.resources[0].props.env.DB = { $resource: "OtherStack/DB" }; }],
  ["opaque unproven binding", (p) => { p.resources[0].props.env.DB = { database_id: "d".repeat(32) }; }],
  ["production service", (p) => { p.resources[0].bindings = [{ type: "service", service: "live" }]; }],
  ["unknown binding type", (p) => { p.resources[0].bindings = [{ data: { bindings: [{ type: "new-binding", name: "NEW" }] } }]; }],
  ["unknown binding field", (p) => { p.resources[0].bindings = [{ data: { bindings: [{ type: "ai", name: "AI", futureTarget: "production" }] } }]; }],
  ["unknown binding data", (p) => { p.resources[0].bindings = [{ data: { futureTarget: "production" } }]; }],
  ["duplicate binding names", (p) => { p.resources[0].bindings = [{ data: { bindings: [{ type: "ai", name: "AI" }, { type: "ai", name: "AI" }] } }]; }],
  ["hidden live credential", (p) => { p.resources[0].bindings = [{ data: { bindings: [{ type: "secret_text", name: "SLACK_BOT_TOKEN" }] } }]; }],
  ["binding auth override", (p) => { p.resources[0].bindings = [{ data: { bindings: [{ type: "plain_text", name: "OPEN_DASHBOARD", text: "1" }] } }]; }],
  ["foreign D1 binding", (p) => { p.resources[0].bindings = [{ data: { bindings: [{ type: "d1", name: "DB", databaseId: "external-id" }] } }]; }],
  ["cross-Worker DO", (p) => { p.resources[0].bindings = [{ data: { bindings: [{ type: "durable_object_namespace", name: "Sandbox", className: "Sandbox", scriptName: "prod" }] } }]; }],
  ["DO transfer", (p) => { p.resources[0].bindings = [{ data: { bindings: [{ type: "durable_object_namespace", name: "Sandbox", className: "Sandbox", transferredFrom: { script: "prod" } }] } }]; }],
  ["unknown resource type", (p) => { p.resources[1].type = "New.Resource"; }],
  ["resource adoption", (p) => { p.resources[1].action = "adopted"; }],
  ["resource replacement", (p) => { p.resources[1].action = "replace"; }],
  ["stack action", (p) => { p.actions = [{ action: "run" }]; }],
  ["empty graph", (p) => { p.resources = []; }],
  ["protected ID anywhere", (p) => { p.forbidden = ["protected-id"]; p.resources[0].props.env.UNEXPECTED = "protected-id"; }],
]) test(`plan refuses ${name}`, () => { const p = plan(); mutate(p); assert.throws(() => validatePlan(p)); });

for (const [type, [prop, attr]] of Object.entries(identities)) {
  test(`${type} requires preview-scoped names and state account`, () => {
    const p = plan(), row = { fqn: "extra", type, action: "noop", props: { [prop]: `resource-${stage}` } };
    if (type === "Cloudflare.Worker") row.props = p.resources[0].props;
    if (type === "Cloudflare.D1Database") row.props.migrations = "./apps/backend/migrations";
    if (type === "Cloudflare.Container") row.props.maxInstances = 1;
    row.state = { status: "created", props: row.props, attr: { [attr]: row.props[prop], accountId: account } };
    p.resources.push(row); validatePlan(p);
    row.state.attr.accountId = "c".repeat(32); assert.throws(() => validatePlan(p));
    row.state.attr.accountId = account; row.props[prop] = "live"; assert.throws(() => validatePlan(p));
  });
}

test("partial or changed state is not safe to reconcile", () => {
  const p = plan(); p.resources[1].state = { status: "updating", attr: { accountId: account, databaseName: `shiba-audit-${stage}` } };
  assert.throws(() => validatePlan(p), /Incomplete/);
  p.resources[1].state.status = "created"; p.resources[1].state.attr.databaseName = "shiba-audit";
  assert.throws(() => validatePlan(p), /Unscoped/);
});

test("real D1/KV/queue/container IDs must resolve to the recorded preview name", async () => {
  for (const type of ["Cloudflare.D1Database", "Cloudflare.KV.Namespace", "Cloudflare.Queues.Queue"]) {
    const attrKey = identities[type][1];
    const resources = [{ type, state: { attr: { [attrKey]: `own-${stage}`, databaseId: "id", namespaceId: "id", queueId: "id", applicationId: "id" } } }];
    await proveExistingTargets(resources, async () => ({ name: `own-${stage}`, title: `own-${stage}`, queue_name: `own-${stage}` }));
    await assert.rejects(proveExistingTargets(resources, async () => ({ name: "prod", title: "prod", queue_name: "prod" })), /ownership changed/);
    await assert.rejects(proveExistingTargets(resources, async () => { throw new Error("403"); }), /403/);
  }
});

function existing() {
  const name = `worker-${stage}`, version = "c".repeat(8) + "-" + "c".repeat(27);
  const resources = [{ type: "Cloudflare.Worker", props: { name }, state: { props: { compatibility: { date: "2026-06-01", flags: ["nodejs_compat"] } }, attr: { accountId: account, workerName: name, durableObjectNamespaces: { Sandbox: "id" } } } },
    { type: "Cloudflare.Container", state: { attr: { accountId: account, applicationId: "app", applicationName: `sandbox-${stage}`, version: 1, configuration: { image: "preview-image" } } } }];
  const responses = {
    namespaces: [{ id: "id", script: name, class: "Sandbox", use_sqlite: true }],
    settings: { compatibility_date: "2026-06-01", compatibility_flags: ["nodejs_compat"], bindings: Object.entries({ OPEN_DASHBOARD: "0", ALCHEMY_STAGE: stage, ALCHEMY_WORKER_NAME: name, ALCHEMY_CLOUDFLARE_ACCOUNT_ID: account }).map(([name, text]) => ({ type: "plain_text", name, text })) },
    deployments: { deployments: [{ id: "deployment", versions: [{ version_id: version, percentage: 100 }] }] },
    version: { id: version, resources: { script_runtime: { containers: [{ class_name: "Sandbox" }] } } },
    service: { default_environment: { environment: "production" } }, routes: [], domains: [], schedules: { schedules: [] },
    app: { name: `sandbox-${stage}`, account_id: account, version: 1, configuration: { image: "preview-image" }, durable_objects: { namespace_id: "id" } },
  };
  const api = async (path) => {
    const key = path.includes("/namespaces?") ? "namespaces" : path.includes("/versions/") ? "version" : path.includes("/environments/") ? "routes" : path.includes("/domains?") ? "domains" : path.includes("/applications/") ? "app" : path.endsWith(name) ? "service" : path.split("/").at(-1);
    assert.ok(key in responses, `Unexpected API ${path}`); return structuredClone(responses[key]);
  };
  return { resources, responses, api };
}
test("existing Worker version, namespace, bindings and Sandbox attachment are proven", async () => {
  const f = existing();
  assert.equal((await proveExistingTargets(f.resources, f.api)).length, 2);
});
for (const [name, mutate] of [
  ["foreign DO", (r) => { r.namespaces[0].script = "prod"; }],
  ["non-SQLite DO", (r) => { r.namespaces[0].use_sqlite = false; }],
  ["split traffic", (r) => { r.deployments.deployments[0].versions[0].percentage = 50; }],
  ["wrong active version", (r) => { r.version.id = "other"; }],
  ["domain", (r) => { r.domains.push({ hostname: "prod" }); }],
  ["route", (r) => { r.routes.push({ pattern: "prod/*" }); }],
  ["unknown routing", (r) => { delete r.routes; }],
  ["cron", (r) => { r.schedules.schedules.push({ cron: "*/5 * * * *" }); }],
  ["container attachment", (r) => { delete r.version.resources.script_runtime.containers; }],
  ["container image", (r) => { r.app.configuration.image = "prod-image"; }],
  ["container namespace", (r) => { r.app.durable_objects.namespace_id = "prod"; }],
  ["container account", (r) => { r.app.account_id = "prod"; }],
  ["container version", (r) => { r.app.version++; }],
  ["compatibility", (r) => { r.settings.compatibility_flags = []; }],
  ["existing foreign binding", (r) => { r.settings.bindings.push({ type: "d1", name: "DB", id: "prod" }); }],
  ["existing service binding", (r) => { r.settings.bindings.push({ type: "service", name: "S", service: "prod" }); }],
  ["existing foreign secret", (r) => { r.settings.bindings.push({ type: "secret_text", name: "GITHUB_TOKEN" }); }],
  ["existing unreviewed field", (r) => { r.settings.bindings[0].environment = "prod"; }],
]) test(`remote proof refuses ${name}`, async () => {
  const f = existing(); mutate(f.responses); await assert.rejects(proveExistingTargets(f.resources, f.api));
});
test("remote proof detects a concurrent deployment or attachment change", async () => {
  const f = existing(), first = await proveExistingTargets(f.resources, f.api);
  f.responses.deployments.deployments[0].id = "concurrent-deployment";
  const second = await proveExistingTargets(f.resources, f.api);
  assert.notDeepEqual(first, second);
});
