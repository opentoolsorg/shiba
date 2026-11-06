import { z } from "zod";
import { FOUNDER_SQL_NOW } from "./founder-connector-context.js";
import { membershipSql, WorkspaceIntegrationError } from "./workspace-integrations-store.js";
import { stripeAvailable, stripeDigest, validStripeContract, type StripeEnv, type StripeGrantRow } from "./founder-stripe-store.js";
import type { WorkspaceNativeMember } from "./workspace-native-authority.js";
import { renderAutomaticSlackReport, type AutomaticSlackGuard } from "./founder-automatic-slack-store.js";

const id=z.string().regex(/^[A-Za-z0-9_]{1,200}$/),hash=z.string().regex(/^[a-f0-9]{64}$/),integer=z.number().int().safe();
const balance=z.strictObject({id:id.regex(/^txn_/),created:integer,currency:z.string().regex(/^[a-z]{3}$/),amount:integer,fee:integer,net:integer,type:z.string().regex(/^[a-z_]{1,100}$/),source:id.nullable()});
const invoice=z.strictObject({id:id.regex(/^in_/),created:integer,currency:z.string().regex(/^[a-z]{3}$/),amountPaid:integer,status:z.enum(['draft','open','paid','uncollectible','void']).nullable(),livemode:z.boolean()});
const reportSchema=z.strictObject({format:z.literal('shiba.stripe-read-report.v1'),principal:z.strictObject({kind:z.literal('schedule'),id:z.string()}),accountId:id.regex(/^acct_/),mode:z.enum(['test','live']),grantId:id,revision:integer,contractDigest:hash,executorDigest:hash,apiVersion:z.literal('2025-10-29.clover'),capturedAt:integer,capturedBytes:integer,notice:z.string().max(1000),capture:z.strictObject({kind:z.enum(['invoices','balance_transactions']),interval:z.strictObject({createdGte:integer,createdLt:integer}),hasMore:z.boolean(),rows:z.array(z.union([balance,invoice])).max(25),captureCompleteness:z.literal('bounded-response'),datasetCompleteness:z.literal('unknown'),businessSuccess:z.literal('unverified')}),summary:z.unknown()});
export interface StripeSlackReceipt { id:string;grant_id:string;grant_revision:number;state:string;selection_json:string;report_json:string;result_digest:string;created_at:number;expires_at:number }
export interface StripeSlackSource {grant:StripeGrantRow;receipt:StripeSlackReceipt;content:string}
const deny=():never=>{throw new WorkspaceIntegrationError('automatic_slack_stripe_source_unavailable',403);};
/** One completed, requester-private receipt; source identity and bytes are rechecked by the SQL guard. */
export async function loadStripeSlackSource(env:StripeEnv,owner:WorkspaceNativeMember,grantId:string,receiptId:string):Promise<StripeSlackSource> {
 stripeAvailable(env);const g=membershipSql(owner,true);
 const grant=await env.AGENT_AUDIT.prepare(`SELECT * FROM founder_stripe_read_grants WHERE id=? AND workspace_id=? AND owner_id=? AND owner_account_id=? AND state IN ('enabled','exhausted') AND expires_at>${FOUNDER_SQL_NOW} AND ${g.sql}`).bind(grantId,owner.workspaceId,owner.userId,owner.accountId,...g.values).first<StripeGrantRow>();
 if(!grant||!await validStripeContract(grant))return deny();
 const original=JSON.parse(grant.owner_json) as WorkspaceNativeMember;if(original.accountId!==owner.accountId||original.userId!==owner.userId||original.workspaceId!==owner.workspaceId||original.version!==owner.version||original.role!==owner.role)return deny();
 const receipt=await env.AGENT_AUDIT.prepare(`SELECT * FROM founder_stripe_read_receipts WHERE id=? AND grant_id=? AND grant_revision=? AND state='completed' AND expires_at>${FOUNDER_SQL_NOW}`).bind(receiptId,grant.id,grant.revision).first<StripeSlackReceipt>();
 if(!receipt||typeof receipt.report_json!=='string'||receipt.report_json.length>100000||await stripeDigest(receipt.report_json)!==receipt.result_digest)return deny();
 const report=reportSchema.parse(JSON.parse(receipt.report_json)),selection=JSON.parse(grant.selection_json) as {kind:string;createdGte:number;createdLt:number;limit:number};
 if(report.grantId!==grant.id||report.revision!==grant.revision||report.contractDigest!==grant.contract_digest||report.executorDigest!==grant.executor_digest||report.accountId!==grant.account_id||report.mode!==grant.mode||report.principal.id!==`schedule:${grant.id}`||receipt.selection_json!==grant.selection_json||report.capture.kind!==selection.kind||report.capture.interval.createdGte!==selection.createdGte||report.capture.interval.createdLt!==selection.createdLt||report.capture.rows.length>selection.limit||report.capturedAt<receipt.created_at||report.capturedAt>=receipt.expires_at)return deny();
 const seen=new Set<string>();
 const rows=report.capture.rows.map(row=>{
  if(seen.has(row.id)||row.created<selection.createdGte||row.created>=selection.createdLt)return deny();seen.add(row.id);
  if(report.capture.kind==='invoices') {if(!('amountPaid'in row)||row.livemode!==(grant.mode==='live'))return deny();return `${row.id} created=${row.created} ${row.currency} amount_paid_minor=${row.amountPaid} status=${row.status??'unknown'}`;}
  if(!('amount'in row)||BigInt(row.amount)-BigInt(row.fee)!==BigInt(row.net))return deny();return `${row.id} created=${row.created} ${row.currency} amount_minor=${row.amount} fee_minor=${row.fee} net_minor=${row.net} type=${row.type} source=${row.source??'unknown'}`;
 });
 const text=[`Stripe scheduled captured evidence (fixed qualified row summary v1).`,`Grant ${grant.id} revision ${grant.revision} contract ${grant.contract_digest}. Executor ${grant.executor_digest}.`,`Receipt ${receipt.id} digest ${receipt.result_digest}. Account ${grant.account_id} mode ${grant.mode}.`,`Captured ${new Date(report.capturedAt).toISOString()}; window [${selection.createdGte}, ${selection.createdLt}) UTC epoch seconds; ${report.capture.kind}; page has_more=${report.capture.hasMore}.`,`Captured rows=${rows.length}; captured bytes=${report.capturedBytes}; bounded response, dataset completeness unknown, business success unverified. This is not a payment, revenue, MRR, churn or full-ledger reconciliation claim.`,`Currency amounts are integer minor units per row. ${report.capture.hasMore ? "The source reports further pages; captured coverage is incomplete." : "One page was captured; full dataset coverage remains unknown."}`,...rows].join('\n');
 const content=renderAutomaticSlackReport(text),source={grant,receipt,content},guard=stripeSlackSourceGuard(source);
 if(!await env.AGENT_AUDIT.prepare(`SELECT 1 AS current WHERE ${guard.sql}`).bind(...guard.values).first())return deny();stripeAvailable(env);if(Date.now()>=Math.min(grant.expires_at,receipt.expires_at))return deny();return source;
}
/** Compose only trusted fixed fields; no source content or caller SQL is executable. */
export function stripeSlackSourceGuard(source:StripeSlackSource):AutomaticSlackGuard {
 const {grant:g,receipt:r}=source,original=membershipSql(JSON.parse(g.owner_json) as WorkspaceNativeMember,true);
 return {sql:`${original.sql} AND EXISTS(SELECT 1 FROM founder_stripe_read_grants g JOIN founder_stripe_read_receipts r ON r.grant_id=g.id AND r.grant_revision=g.revision WHERE g.id=? AND g.workspace_id=? AND g.owner_id=? AND g.owner_account_id=? AND g.owner_json=? AND g.revision=? AND g.contract_digest=? AND g.executor_digest=? AND g.selection_json=? AND g.account_id=? AND g.mode=? AND g.expires_at=? AND g.max_calls=? AND g.state IN ('enabled','exhausted') AND g.expires_at>${FOUNDER_SQL_NOW} AND r.id=? AND r.state='completed' AND r.selection_json=? AND r.report_json=? AND r.result_digest=? AND r.created_at=? AND r.expires_at=? AND r.expires_at>${FOUNDER_SQL_NOW})`,values:[...original.values,g.id,g.workspace_id,g.owner_id,g.owner_account_id,g.owner_json,g.revision,g.contract_digest,g.executor_digest,g.selection_json,g.account_id,g.mode,g.expires_at,g.max_calls,r.id,r.selection_json,r.report_json,r.result_digest,r.created_at,r.expires_at]};
}
