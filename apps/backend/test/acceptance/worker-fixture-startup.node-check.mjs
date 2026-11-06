import assert from "node:assert/strict";
import { test } from "node:test";
import { waitForWorkerReady } from "./worker-fixture.mjs";

const worker = () => ({ exitCode: null, signalCode: null });
const options = () => ({ worker: worker(), origin: "http://127.0.0.1:1", logs: ["Wrangler starting\n"], timeoutMs: 20 });

test("readiness succeeds only for an OK bootstrap response", async () => {
  await waitForWorkerReady({ ...options(), fetchImpl: async () => ({ ok: true }) });
});

test("timeout reports the last HTTP status and logs without response contents", async () => {
  await assert.rejects(waitForWorkerReady({ ...options(), fetchImpl: async () => ({ ok: false, status: 503 }) }), /startup timed out.*last: HTTP 503[\s\S]*Wrangler starting/);
});

test("timeout reports a connection failure code without its message", async () => {
  const error = Object.assign(new Error("sensitive message"), { cause: { code: "ECONNREFUSED" } });
  await assert.rejects(waitForWorkerReady({ ...options(), fetchImpl: async () => { throw error; } }), (failure) => {
    assert.match(failure.message, /last: request error ECONNREFUSED/);
    assert.doesNotMatch(failure.message, /sensitive message/);
    return true;
  });
});

test("spawn failure and child exit fail without waiting for the deadline", async () => {
  for (const [child, pattern] of [[{ ...worker(), fixtureSpawnError: "ENOENT" }, /failed to spawn \(ENOENT\)/], [{ ...worker(), exitCode: 1 }, /exited \(code 1, signal null\)/]]) {
    await assert.rejects(waitForWorkerReady({ ...options(), worker: child, fetchImpl: async () => { throw new Error("unexpected probe"); } }), pattern);
  }
});
