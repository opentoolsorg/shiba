#!/usr/bin/env node
// Opt-in, local-only integration: node scripts/verify-native-coordinator.mjs /path/to/pinned/upstream
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { upstreamReadApi } from '../../../infra/openconnector-read-gateway.mjs';
import { coordinatedGatewayEntry } from '../../../infra/openconnector-coordinated-gateway.mjs';
import { revision } from '../../../infra/openconnector.mjs';

const sourceArgument = process.argv[2];
if (!sourceArgument) {
  console.log('SKIP: supply a local pinned upstream checkout argument. No download, provisioning, or deployment is performed.');
  process.exit(0);
}
const source = resolve(sourceArgument);
const git = (...args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim();
assert.equal(git('rev-parse', 'HEAD'), revision, 'Upstream revision must match the production pin');
assert.equal(git('status', '--porcelain', '--untracked-files=no'), '', 'Upstream tracked source must be clean');
for (const [path, expected] of Object.entries(upstreamReadApi)) {
  const bytes = await readFile(join(source, path));
  assert.equal(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), expected, path);
}
const require = createRequire(join(source, 'package.json'));
// biome-ignore lint/correctness/noUndeclaredDependencies: Uses the verified upstream checkout's installed build toolchain, not a package import.
const { build } = require('esbuild');
// biome-ignore lint/correctness/noUndeclaredDependencies: Uses the verified upstream checkout's installed Wrangler runtime toolchain.
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const ownerPath = fileURLToPath(new URL('../src/coordinated-owner.ts', import.meta.url));
const storePath = fileURLToPath(new URL('../src/operator-store.ts', import.meta.url));
const entry = `
import {DurableObject} from 'cloudflare:workers';
import upstream from ${JSON.stringify(join(source, 'src/server/cloudflare.ts'))};
import {CoordinatedOwner} from ${JSON.stringify(ownerPath)};
import {OperatorInvocationStore} from ${JSON.stringify(storePath)};
let assetsReads=0;
const assets={fetch:async()=>{assetsReads++;return Response.json({version:1,providerCount:0,chunks:[]})}};
export class FixtureOwner extends DurableObject {
 constructor(ctx,env){super(ctx,env);this.owner=new CoordinatedOwner();this.database=this.owner.database(env.DB);this.store=new OperatorInvocationStore(ctx.storage);this.store.recover();this.store.initializeEpoch('fixture-epoch');this.nativeEnv={...env,DB:this.database,ASSETS:assets};}
 async fetch(request){
  const path=new URL(request.url).pathname;
  if(path==='/__fixture/claim')return this.owner.run(async()=>{const result=this.store.claim({deploymentEpoch:'fixture-epoch',invocationId:'fixture-invocation',requestDigest:'fixture-digest',approvalId:'fixture-approval'});await this.store.flush();return Response.json(result)});
  if(path==='/__fixture/receipt')return this.owner.run(async()=>Response.json(this.store.lookup('fixture-invocation','fixture-digest')));
  if(path==='/__fixture/cache')return Response.json({assetsReads});
  if(path==='/__fixture/scheduled'){
   let waitUntilCount=0;
   await this.owner.run(async ctx=>upstream.scheduled({},this.nativeEnv,{...ctx,waitUntil:promise=>{waitUntilCount++;ctx.waitUntil(promise.then(async()=>{await this.database.prepare('INSERT INTO fixture_background(value) VALUES (?)').bind('drained').run()}))}}));
   return Response.json({waitUntilCount});
  }
  return this.owner.nativeFetch(ctx=>upstream.fetch(request,this.nativeEnv,ctx));
 }
}
export default {fetch(request,env){return env.OWNER.get(env.OWNER.idFromName('single-permanent-owner')).fetch(request)}};
`;
const bundled = await build({ stdin: { contents: entry, resolveDir: source, sourcefile: 'native-coordinator-fixture.ts', loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['node:*', 'cloudflare:*'],
  // The package's browser condition uses document; workerd needs its non-DOM implementation.
  alias: { 'decode-named-character-reference': join(source, 'node_modules/decode-named-character-reference/index.js') },
  plugins: [{ name: 'node-builtins', setup(build) { build.onResolve({ filter: /^(http|https|url|timers)$/ }, args => ({ path: `node:${args.path}`, external: true })); } }],
});
const persistence = await mkdtemp(join(tmpdir(), 'shiba-native-coordinator-'));
let outboundCalls = 0;
// Disable Miniflare's host-side CF metadata HTTP fetch as well as all Worker egress.
const start = () => new Miniflare(convertV4MiniflareOptions({ cf: false, modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2026-07-02', compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
  name: 'native-coordinator-fixture', resourcePersistencePath: join(persistence, 'resources'), isolatedResourcePersistencePath: join(persistence, 'isolated'),
  d1Databases: ['DB'], r2Buckets: ['TRANSIT_FILES'],
  durableObjects: { OWNER: { className: 'FixtureOwner', useSQLite: true } },
  bindings: { OOMOL_CONNECT_ORIGIN: 'https://fixture.invalid', OOMOL_CONNECT_ADMIN_TOKEN: 'fixture-admin-not-real', OOMOL_CONNECT_RUNTIME_TOKEN: 'fixture-runtime-not-real' },
  outboundService: async () => { outboundCalls++; throw new Error('External egress forbidden in offline verification'); },
}));
let mf;
let checks = 0;
try {
  mf = start();
  const db = await mf.getD1Database('DB');
  const migrations = (await readdir(join(source, 'migrations'))).filter(name => name.endsWith('.sql')).sort();
  for (const file of migrations) {
    const sql = await readFile(join(source, 'migrations', file), 'utf8');
    const statements = sql.replace(/--[^\n]*/g, '').split(';').map(part => part.trim()).filter(Boolean);
    await db.batch(statements.map(statement => db.prepare(statement)));
  }
  await db.prepare('CREATE TABLE fixture_background(value TEXT)').run();
  const fetchJson = async (path, options = {}) => {
    const response = await mf.dispatchFetch(`https://fixture.invalid${path}`, options);
    const body = await response.text();
    assert.equal(response.status, 200, `${path}: ${body}`); checks++;
    return JSON.parse(body);
  };
  for (let iteration = 0; iteration < 3; iteration++) {
    assert.equal((await fetchJson('/health')).ok, true);
    assert.deepEqual((await fetchJson('/v1/providers', { headers: { authorization: 'Bearer fixture-runtime-not-real' } })).data, []);
  }
  assert.equal((await fetchJson('/__fixture/cache')).assetsReads, 1);
  const adminHeaders = { authorization: 'Bearer fixture-admin-not-real', 'content-type': 'application/json' };
  await fetchJson('/api/runtime-policy', { method: 'PUT', headers: adminHeaders, body: JSON.stringify({ allowedActions: ['*'], blockedActions: ['fixture.blocked'], allowedProxies: [], blockedProxies: [], allowedTriggers: [], blockedTriggers: [] }) });
  const policy = await fetchJson('/api/runtime-policy', { headers: adminHeaders });
  assert.ok(JSON.stringify(policy).includes('fixture.blocked'), 'Native mutation must survive cached-app reuse');
  assert.equal((await fetchJson('/__fixture/scheduled')).waitUntilCount, 1);
  assert.equal((await db.prepare('SELECT count(*) AS count FROM fixture_background').first()).count, 1, 'Background SQL must finish before owner returns');
  assert.equal((await fetchJson('/__fixture/claim')).acquired, true);
  await mf.dispose();
  mf = start();
  const recovered = await fetchJson('/__fixture/receipt');
  assert.equal(recovered.state, 'unknown');
  assert.equal(recovered.code, 'operator_process_interrupted');
  const replay = await fetchJson('/__fixture/claim');
  assert.equal(replay.acquired, false);
  assert.equal(replay.receipt.state, 'unknown');
  const persistedPolicy = await fetchJson('/api/runtime-policy', { headers: adminHeaders });
  assert.ok(JSON.stringify(persistedPolicy).includes('fixture.blocked'));
  // Compile the exact emitted alternative entry, not a hand-written approximation.
  const upstreamServer = join(source, 'src/server');
  const runtimeIndex = fileURLToPath(new URL('../src/operator-runtime.ts', import.meta.url));
  let runtimeImport = relative(upstreamServer, runtimeIndex).split('\\').join('/');
  if (!runtimeImport.startsWith('.')) runtimeImport = `./${runtimeImport}`;
  const generatedEntry = coordinatedGatewayEntry(runtimeImport);
  const emitted = await build({
    entryPoints: ['shiba-generated-fixture'], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['node:*', 'cloudflare:*'],
    alias: { 'decode-named-character-reference': join(source, 'node_modules/decode-named-character-reference/index.js') },
    plugins: [
      { name: 'generated-entry', setup(build) {
        build.onResolve({ filter: /^shiba-generated-fixture$/ }, () => ({ path: 'shiba-generated-fixture', namespace: 'fixture' }));
        build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: generatedEntry, resolveDir: upstreamServer, loader: 'ts' }));
      } },
      { name: 'node-builtins', setup(build) { build.onResolve({ filter: /^(http|https|url|timers)$/ }, args => ({ path: `node:${args.path}`, external: true })); } },
    ],
  });
  const generated = new Miniflare(convertV4MiniflareOptions({
    cf: false, name: 'generated-entry-fixture', modules: true, script: emitted.outputFiles[0].text,
    compatibilityDate: '2026-07-02', compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
    d1Databases: ['DB'], r2Buckets: ['TRANSIT_FILES'],
    durableObjects: { SHIBA_CONNECTOR_OWNER: { className: 'ShibaOpenConnectorOwner', useSQLite: true } },
    serviceBindings: { ASSETS: async () => Response.json({ version: 1, providerCount: 0, chunks: [] }) },
    bindings: { OOMOL_CONNECT_ORIGIN: 'https://fixture.invalid', OOMOL_CONNECT_ADMIN_TOKEN: 'fixture-admin-not-real', OOMOL_CONNECT_RUNTIME_TOKEN: 'fixture-runtime-not-real', SHIBA_OPERATOR_EPOCH: 'fixture-epoch' },
    outboundService: async () => { outboundCalls++; throw new Error('External egress forbidden in generated entry verification'); },
  }));
  try {
    const generatedDb = await generated.getD1Database('DB');
    for (const file of migrations) {
      const sql = await readFile(join(source, 'migrations', file), 'utf8');
      const statements = sql.replace(/--[^\n]*/g, '').split(';').map(part => part.trim()).filter(Boolean);
      await generatedDb.batch(statements.map(statement => generatedDb.prepare(statement)));
    }
    for (let iteration = 0; iteration < 3; iteration++) {
      for (const path of ['/health', '/api/runtime-policy']) {
        const response = await generated.dispatchFetch(`https://fixture.invalid${path}`, { headers: adminHeaders });
        assert.equal(response.status, 200, await response.text()); checks++;
      }
    }
    await (await generated.getDurableObjectNamespace('SHIBA_CONNECTOR_OWNER')).getByName('shiba-openconnector-owner-v1').runScheduled({});
    const scheduled = await (await generated.getWorker()).scheduled({ cron: '* * * * *', scheduledTime: Date.now() });
    assert.equal(scheduled.outcome, 'ok');
    for (const path of ['/v1/shiba/operator-gate/execute', '/v1/shiba/%6fperator-gate/execute']) {
      const response = await generated.dispatchFetch(`https://fixture.invalid${path}`, { method: 'POST' });
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error, 'operator_activation_unavailable'); checks++;
    }
  } finally { await generated.dispose(); }
  assert.equal(outboundCalls, 0);
  assert.equal(git('status', '--porcelain', '--untracked-files=no'), '');
  console.log(JSON.stringify({ status: 'passed', upstreamRevision: revision, hashPins: Object.keys(upstreamReadApi).length, migrations: migrations.length, httpChecks: checks, cacheReuse: true, nativePolicyMutation: true, scheduledWaitUntilDrained: true, durableRecovery: true, fixedOwnerId: true, generatedEntry: true, generatedScheduled: true, reservedOperatorDenied: true, outboundCalls, bundleBytes: bundled.outputFiles[0].contents.length }, null, 2));
} finally {
  await mf?.dispose();
  await rm(persistence, { recursive: true, force: true });
}
