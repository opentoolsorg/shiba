import { D1ThreadQueue } from "../../adapters/thread-queue/d1/index.js";
import type { ThreadQueue } from "./index.js";

export interface ThreadQueueEnv {
  AGENT_AUDIT: D1Database;
}

const adapters = {
  d1: (env: ThreadQueueEnv, _threadKey: string): ThreadQueue => new D1ThreadQueue(env.AGENT_AUDIT),
};

/** Resolve at the thread boundary so a future adapter can use thread addressing. */
export function threadQueueFor(env: ThreadQueueEnv, threadKey: string): ThreadQueue {
  return adapters.d1(env, threadKey);
}
