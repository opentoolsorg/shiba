import { readFileSync,writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const files=["founder-reconciliation-schedule-sources.ts","founder-reconciliation-schedule-store.ts","founder-reconciliation-schedule-runtime.ts","founder-reconciliation-schedule-routes.ts","founder-reconciliation-generated.ts","../migrations/0033_founder_reconciliation_schedules.sql","../../../packages/shared/src/founder-reconciliation-schedules.ts"];
const sha=value=>createHash("sha256").update(value).digest("hex"),sources=files.map(file=>({file,sha256:sha(readFileSync(new URL(file,import.meta.url)))}));
const content=`/** Generated; a change requires a new reviewed standing grant. */\nexport const FOUNDER_RECONCILIATION_SCHEDULE_EXECUTOR_DIGEST = ${JSON.stringify(sha(JSON.stringify(sources)))};\n`,target=new URL("founder-reconciliation-schedule-generated.ts",import.meta.url);
if(process.argv.includes("--check")){if(readFileSync(target,"utf8")!==content)throw new Error("Reconciliation schedule pin is stale");}else writeFileSync(target,content);
