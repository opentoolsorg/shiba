import assert from "node:assert/strict";

export function validateContext({ stage, account, expectedAccount, head, checkout, pr, repository, operation }) {
  assert.match(stage, /^pr-[1-9]\d*$/, "Expected a PR stage");
  assert.match(expectedAccount ?? "", /^[a-f0-9]{32}$/, "Missing preview account allowlist");
  assert.equal(account, expectedAccount, "Unexpected Cloudflare account");
  assert.equal(stage, `pr-${pr.number}`, "Stage does not match PR");
  assert.equal(pr.headRepository?.nameWithOwner, repository, "Fork previews are forbidden");
  assert.ok(operation === "destroy" ? ["CLOSED", "MERGED"].includes(pr.state) : pr.state === "OPEN", "Unexpected PR state");
  if (operation !== "destroy") {
    assert.ok(pr.labels?.some((label) => label.name === "preview:deploy"), "Preview label removed");
    assert.match(head ?? "", /^[a-f0-9]{40}$/, "Missing exact head SHA");
    assert.equal(pr.headRefOid, head, "PR head changed");
    assert.equal(checkout, head, "Checkout does not match validated PR head");
  }
}

// Only these resource identities are understood; a new resource kind needs a reviewed guard.
export const identities = {
  "Cloudflare.Worker": ["name", "workerName"],
  "Cloudflare.D1Database": ["name", "databaseName"],
  "Cloudflare.KV.Namespace": ["title", "title"],
  "Cloudflare.R2.Bucket": ["name", "bucketName"],
  "Cloudflare.VectorizeIndex": ["name", "indexName"],
  "Cloudflare.VectorizeMetadataIndex": ["indexName", "indexName"],
  "Cloudflare.Queues.Queue": ["name", "queueName"],
  "Cloudflare.Container": ["name", "applicationName"],
  "Cloudflare.Workflow": ["workflowName", "workflowName"],
};

export function validatePlan({ stage, account, resources, actions = [], operation, forbidden = [], head }) {
  assert.equal(actions.length, 0, "Unreviewed stack action");
  const scoped = (value) => assert.ok(typeof value === "string" && value.endsWith(`-${stage}`), `Unscoped target: ${value}`);
  const known = new Set(resources.map((r) => r.fqn));
  assert.ok(known.size > 0 && known.size === resources.length, "Missing or duplicate resource graph");
  const allowedIds = new Set([account]);
  for (const row of resources) {
    const identity = identities[row.type], consumer = row.type === "Cloudflare.Queues.Consumer";
    assert.ok(identity || consumer, `Unknown resource type: ${row.type}`);
    assert.ok(!["adopted", "replace", "orphaned"].includes(row.action), "Adoption/replacement requires manual review");
    const props = row.props ?? row.state?.props;
    assert.ok(props, "Missing resource properties");
    if (identity) scoped(props[identity[0]]);
    if (consumer) {
      const queues = resources.filter((r) => r.type === "Cloudflare.Queues.Queue");
      const queue = queues.find((r) => props.queueId?.$resource === r.fqn || (operation === "destroy" && r.state?.attr?.queueId === props.queueId));
      assert.ok(queue, "Consumer queue must belong to the preview plan");
      const workerName = `shiba-ai-coworker-${stage}`;
      assert.ok(resources.some((r) => r.type === "Cloudflare.Worker" && r.props?.name === workerName && (props.scriptName?.$resource === r.fqn || props.scriptName === workerName)), "Consumer Worker must belong to the preview plan");
      const deadLetterQueue = queues.find((r) => props.deadLetterQueue?.$resource === r.fqn || r.props?.name === props.deadLetterQueue);
      assert.ok(deadLetterQueue, "Consumer dead-letter queue must belong to the preview plan");
      scoped(deadLetterQueue.props?.name);
      if (row.state) {
        assert.equal(row.state.attr?.queueId, queue.state?.attr?.queueId, "Consumer state queue drift");
        assert.ok(row.state.attr?.queueId, "Consumer state queue is unproven");
        assert.equal(row.state.attr.scriptName, workerName, "Consumer state Worker drift");
        assert.equal(row.state.attr.deadLetterQueue, deadLetterQueue.props.name, "Consumer state dead-letter queue drift");
      }
    }
    assert.ok(!props.clone && !props.importFiles, "Preview must not import or clone data");
    if (row.state) {
      assert.ok(["created", "updated"].includes(row.state.status), "Incomplete state requires manual review");
      assert.equal(row.state.attr?.accountId, account, "State account is unproven");
      if (identity) {
        scoped(row.state.attr[identity[1]]);
        assert.equal(row.state.attr[identity[1]], props[identity[0]], "State target changed");
      }
      if (row.type === "Cloudflare.Worker") {
        assert.ok(!row.state.attr.domain && !row.state.attr.routes?.length && !row.state.attr.crons?.length, "Existing preview has live triggers");
        Object.values(row.state.attr.durableObjectNamespaces ?? {}).forEach((id) => allowedIds.add(id));
      }
      for (const [key, value] of Object.entries(row.state.attr)) {
        if (/(?:Id|_id)$/.test(key) && typeof value === "string") allowedIds.add(value);
      }
    }
    if (row.type === "Cloudflare.Worker" && operation !== "destroy") {
      assert.equal(props.name, `shiba-ai-coworker-${stage}`);
      assert.ok(!props.domain && !props.routes && !props.crons?.length, "Preview routes/crons forbidden");
      assert.equal(props.env?.OPEN_DASHBOARD ?? "0", "0", "Preview auth must remain enabled");
      assert.ok(!props.env?.SLACK_BOT_TOKEN && !props.env?.SLACK_SIGNING_SECRET, "Live Slack credentials forbidden");
      assert.match(head ?? "", /^[a-f0-9]{40}$/, "Missing preview commit");
      assert.equal(props.env?.SHIBA_PREVIEW_COMMIT, head, "Wrong deployed commit");
      assert.ok(!props.version && !props.preview && !props.namespace, "External Worker parent forbidden");
    }
    if (row.type === "Cloudflare.D1Database" && operation !== "destroy") {
      assert.equal(props.migrations, "./apps/backend/migrations", "Preview migrations missing");
    }
    if (row.type === "Cloudflare.Container") assert.equal(props.maxInstances, 1, "Preview container cap must be 1");
  }
  const target = (value, type, field) => {
    const matches = resources.filter((r) => r.type === type);
    assert.ok(matches.some((r) => value?.$resource === r.fqn ||
      (typeof value === "string" && (value === r.props?.[field] || value === r.state?.attr?.[field]))), `Unproven ${type} binding target`);
  };
  for (const row of resources) {
    const seen = new Set();
    for (const entry of row.bindings ?? []) {
      const data = entry.data ?? {};
      assert.ok(Object.keys(data).every((k) => data[k] === undefined || ["bindings", "containers", "scriptName", "durableObjects"].includes(k)), "Unreviewed binding data");
      if (data.scriptName) target(data.scriptName, "Cloudflare.Worker", "workerName");
      if (data.durableObjects) {
        assert.deepEqual(Object.keys(data.durableObjects), ["namespaceId"], "Unknown container attachment fields");
        target(data.durableObjects.namespaceId, "Cloudflare.Worker", "workerName");
      }
      for (const c of data.containers ?? []) {
        assert.ok(c.className === "Sandbox" && Object.keys(c).every((k) => c[k] === undefined || ["className", "dev", "hash"].includes(k)), "Unreviewed container attachment");
        for (const value of [c.dev, c.hash].filter(Boolean)) target(value, "Cloudflare.Container", "applicationName");
      }
      for (const binding of data.bindings ?? []) {
        const { type } = binding;
        assert.ok(binding.name && !seen.has(binding.name), "Missing or duplicate binding name"); seen.add(binding.name);
        const fields = { plain_text: ["text"], secret_text: ["text"], ai: [], version_metadata: [], worker_loader: [], browser: [], ratelimit: ["namespaceId", "simple"], durable_object_namespace: ["className"], d1: ["databaseId"], kv_namespace: ["namespaceId"], r2_bucket: ["bucketName", "jurisdiction"], vectorize: ["indexName"], queue: ["queueId", "queueName"], workflow: ["workflowName", "className"] };
        assert.ok(fields[type] && Object.keys(binding).every((k) => binding[k] === undefined || ["name", "type", ...fields[type]].includes(k)), "Unknown preview binding type or field");
        if (type === "secret_text") assert.ok(["BETTER_AUTH_SECRET", "BETTER_AUTH_OWNER_EMAIL", "INTERNAL_SIGNING_KEY", "ARTIFACT_SIGNING_KEY"].includes(binding.name), "Unreviewed preview secret");
        if (binding.name === "OPEN_DASHBOARD") assert.equal(binding.text, "0", "Preview auth override forbidden");
        if (["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"].includes(binding.name)) assert.fail("Live Slack binding forbidden");
        if (["plain_text", "secret_text", "ai", "version_metadata", "worker_loader", "browser", "ratelimit"].includes(type)) continue;
        if (type === "durable_object_namespace") {
          assert.ok(binding.className && !binding.scriptName && !binding.namespaceId && !binding.transferredFrom, "Only local preview DO classes are allowed");
        } else if (type === "d1") target(binding.databaseId, "Cloudflare.D1Database", "databaseId");
        else if (type === "kv_namespace") target(binding.namespaceId, "Cloudflare.KV.Namespace", "namespaceId");
        else if (type === "r2_bucket") target(binding.bucketName, "Cloudflare.R2.Bucket", "bucketName");
        else if (type === "vectorize") target(binding.indexName, "Cloudflare.VectorizeIndex", "indexName");
        else if (type === "queue") {
          target(binding.queueId, "Cloudflare.Queues.Queue", "queueId");
          if (binding.queueName) target(binding.queueName, "Cloudflare.Queues.Queue", "queueName");
        } else if (type === "workflow") target(binding.workflowName, "Cloudflare.Workflow", "workflowName");
        else assert.fail(`Unknown preview binding type: ${type}`);
      }
    }
  }
  const walk = (value, key = "") => {
    if (typeof value === "string") {
      assert.ok(!forbidden.some((id) => id && value.includes(id)), "Protected resource ID in preview plan");
      if (/^[a-f0-9]{32}$|^[a-f0-9]{8}-[a-f0-9-]{27}$/.test(value)) assert.ok(allowedIds.has(value), `Unproven resource ID in ${key}`);
      if (/^(scriptName|script_name|service|bucket_name|index_name|queue_name)$/.test(key)) scoped(value);
      if (/^(accountId|account_id)$/.test(key)) assert.equal(value, account);
    } else if (Array.isArray(value)) value.forEach((v) => walk(v, key));
    else if (value && typeof value === "object") {
      if ("$resource" in value) assert.ok(known.has(value.$resource), "External resource reference");
      else for (const [k, v] of Object.entries(value)) walk(v, k);
    }
  };
  resources.forEach(walk);
}

export async function proveExistingTargets(resources, api) {
  const proof = [];
  for (const row of resources.filter((r) => r.state)) {
    const attr = row.state.attr;
    if (row.type === "Cloudflare.Worker") {
      const namespaces = [];
      for (let page = 1; page <= 10; page++) {
        const batch = await api(`/workers/durable_objects/namespaces?per_page=100&page=${page}`);
        assert.ok(Array.isArray(batch), "Namespace enumeration is unproven");
        namespaces.push(...batch);
        if (batch.length < 100) break;
        assert.ok(page < 10, "Namespace enumeration exceeded its safety bound");
      }
      for (const [className, id] of Object.entries(attr.durableObjectNamespaces ?? {})) {
        assert.ok(namespaces.some((n) => n.id === id && n.script === attr.workerName && n.class === className && n.use_sqlite === true), "Durable Object namespace ownership unproven");
      }
      const base = `/workers/scripts/${attr.workerName}`, service = `/workers/services/${attr.workerName}`;
      const settings = await api(`${base}/settings`), deployment = (await api(`${base}/deployments`)).deployments?.[0];
      assert.ok(deployment?.id && deployment.versions?.length === 1 && deployment.versions[0].percentage === 100, "Active preview version missing or split");
      const versionId = deployment.versions[0].version_id;
      assert.match(versionId ?? "", /^[a-f0-9-]{36}$/, "Invalid active version");
      const version = await api(`${base}/versions/${versionId}`);
      assert.equal(version.id, versionId, "Active version changed");
      assert.equal((await api(service)).default_environment?.environment, "production", "Unexpected Worker environment");
      for (const rows of [await api(`${service}/environments/production/routes?show_zonename=true`), await api(`/workers/domains?service=${attr.workerName}`), (await api(`${base}/schedules`)).schedules]) {
        assert.ok(Array.isArray(rows) && rows.length === 0, "Preview routing/schedules are not empty or unproven");
      }
      validateExistingBindings(settings.bindings, resources, row);
      assert.equal(settings.compatibility_date, row.state.props?.compatibility?.date, "Compatibility date drift");
      assert.deepEqual([...(settings.compatibility_flags ?? [])].sort(), [...(row.state.props?.compatibility?.flags ?? [])].sort(), "Compatibility flags drift");
      const containers = resources.filter((r) => r.type === "Cloudflare.Container" && r.state);
      assert.deepEqual(version.resources?.script_runtime?.containers ?? [], containers.map(() => ({ class_name: "Sandbox" })), "Container attachment metadata changed");
      proof.push({ deployment, settings, runtime: version.resources });
    }
    if (row.type === "Cloudflare.Queues.Consumer") {
      const actual = await api(`/queues/${attr.queueId}/consumers/${attr.consumerId}`);
      assert.equal(actual.type, "worker", "Unexpected Consumer type");
      assert.equal(actual.consumer_id, attr.consumerId, "Consumer identity drift");
      assert.equal(actual.script, attr.scriptName, "Consumer Worker ownership changed");
      assert.equal(actual.dead_letter_queue, attr.deadLetterQueue, "Consumer dead-letter queue changed");
      proof.push(actual);
      continue;
    }
    let actual;
    if (row.type === "Cloudflare.D1Database") actual = (await api(`/d1/database/${attr.databaseId}`)).name;
    else if (row.type === "Cloudflare.KV.Namespace") actual = (await api(`/storage/kv/namespaces/${attr.namespaceId}`)).title;
    else if (row.type === "Cloudflare.Queues.Queue") actual = (await api(`/queues/${attr.queueId}`)).queue_name;
    else if (row.type === "Cloudflare.Container") {
      const app = await api(`/containers/applications/${attr.applicationId}`);
      actual = app.name;
      assert.equal(app.account_id, attr.accountId, "Container account drift");
      assert.equal(app.version, attr.version, "Container version drift");
      assert.equal(app.configuration?.image, attr.configuration?.image, "Container image drift");
      const worker = resources.find((r) => r.type === "Cloudflare.Worker" && r.state);
      assert.ok(worker?.state.attr.durableObjectNamespaces?.Sandbox, "Container namespace missing");
      assert.equal(app.durable_objects?.namespace_id, worker.state.attr.durableObjectNamespaces.Sandbox, "Container namespace drift");
      proof.push(app);
    }
    else continue; // Other resources are addressed by their already-validated names, not opaque ids.
    assert.equal(actual, attr[identities[row.type][1]], "Cloudflare resource ownership changed");
  }
  return proof;
}

function validateExistingBindings(bindings, resources, worker) {
  assert.ok(Array.isArray(bindings), "Existing bindings unproven");
  const targets = { d1: ["Cloudflare.D1Database", "databaseId", "id"], kv_namespace: ["Cloudflare.KV.Namespace", "namespaceId", "namespace_id"], r2_bucket: ["Cloudflare.R2.Bucket", "bucketName", "bucket_name"], vectorize: ["Cloudflare.VectorizeIndex", "indexName", "index_name"], queue: ["Cloudflare.Queues.Queue", "queueName", "queue_name"], workflow: ["Cloudflare.Workflow", "workflowName", "workflow_name"] };
  const fields = { plain_text: ["text"], secret_text: [], ai: [], assets: [], browser: [], worker_loader: [], version_metadata: [], ratelimit: ["namespace_id", "simple"], durable_object_namespace: ["namespace_id", "class_name"], d1: ["id"], kv_namespace: ["namespace_id"], r2_bucket: ["bucket_name", "jurisdiction"], vectorize: ["index_name"], queue: ["queue_name"], workflow: ["workflow_name", "class_name"] };
  const seen = new Set();
  for (const b of bindings) {
    assert.ok(fields[b.type] && !seen.has(b.name), "Unknown or duplicate existing binding"); seen.add(b.name);
    assert.ok(Object.keys(b).every((k) => ["type", "name", ...fields[b.type]].includes(k)), "Unreviewed existing binding field");
    assert.ok(!["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"].includes(b.name), "Existing Slack credential forbidden");
    if (b.type === "secret_text") assert.ok(["BETTER_AUTH_SECRET", "BETTER_AUTH_OWNER_EMAIL", "INTERNAL_SIGNING_KEY", "ARTIFACT_SIGNING_KEY"].includes(b.name), "Unreviewed existing secret");
    if (targets[b.type]) {
      const [type, attr, field] = targets[b.type];
      assert.ok(resources.some((r) => r.type === type && r.state?.attr?.[attr] === b[field]), "Existing binding target unproven");
    }
    if (b.type === "durable_object_namespace") {
      assert.ok(b.class_name && b.namespace_id, "Existing DO identity missing");
      assert.equal(b.namespace_id, worker.state.attr.durableObjectNamespaces?.[b.class_name], "Existing DO binding drift");
    }
  }
  const plain = (name) => bindings.find((b) => b.name === name)?.text;
  assert.equal(plain("OPEN_DASHBOARD"), "0", "Existing preview auth disabled");
  for (const name of ["WORKER_HOSTNAME", "BETTER_AUTH_URL"]) assert.equal(plain(name), worker.state.props?.env?.[name], "Existing preview hostname drift");
  assert.equal(plain("ALCHEMY_STAGE"), worker.props.name.match(/pr-\d+$/)?.[0], "Existing preview stage drift");
  assert.equal(plain("ALCHEMY_WORKER_NAME"), worker.props.name, "Existing Worker identity drift");
  assert.equal(plain("ALCHEMY_CLOUDFLARE_ACCOUNT_ID"), worker.state.attr.accountId, "Existing account identity drift");
}
