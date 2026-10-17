// Isolated source-derived benchmark, not an application/runtime profile.
// Run: node docs/performance/stream-buffer-benchmark.mjs
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { stripTypeScriptTypes } from 'node:module';
const source = readFileSync(new URL('../../apps/backend/src/runtime.ts', import.meta.url), 'utf8');
const start = source.indexOf('function streamProgress(');
const end = source.indexOf('\nfunction summarizeRun(', start);
if (start < 0 || end < 0) throw new Error('Source boundaries changed');
const functionSource = stripTypeScriptTypes(source.slice(start, end));
// Only exercise valid incomplete input: no parser/error-class branch is reached.
const factory = new Function('MAX_PROGRESS_EVENTS', `${functionSource}\nreturn streamProgress;`)(256);
const chunk = 'x'.repeat(1024);
const samples = [];
for (const chunks of [256, 512, 1024, 2048]) {
  const durations = [];
  for (let repeat = 0; repeat < 3; repeat++) {
    const stream = factory({ name: 'probe', parseEvent: () => null }, async () => {});
    const t0 = performance.now();
    for (let i = 0; i < chunks; i++) stream.onData('stdout', chunk);
    durations.push(performance.now() - t0);
    await stream.finish();
  }
  durations.sort((a, b) => a - b);
  samples.push({ chunks, inputBytes: chunks * chunk.length,
    rescannedCharacters: chunk.length * chunks * (chunks + 1) / 2,
    medianMs: Number(durations[1].toFixed(3)) });
}
console.log(JSON.stringify({ kind: 'synthetic-source-extract', node: process.version,
  workload: '1 KiB stdout fragments without a newline; three trials, median', samples }, null, 2));
