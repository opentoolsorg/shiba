/** Closed Meta Marketing API surface; no caller-controlled origin, path, fields, or pagination. */
export const FOUNDER_META_API_VERSION = "v25.0";
export const FOUNDER_META_UPSTREAM_PIN = "d89dc9";
export interface MetaReadSelection { since: string; until: string; limit: number }
const day = (text: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error("meta_date_invalid");
  const value = Date.parse(`${text}T00:00:00Z`);
  if (!Number.isFinite(value) || new Date(value).toISOString().slice(0,10) !== text) throw new Error("meta_date_invalid");
  return value;
};
export function validateMetaSelection(s: MetaReadSelection) {
  if (!s || typeof s !== "object" || Array.isArray(s) || Object.keys(s).sort().join(",") !== "limit,since,until" || !Number.isInteger(s.limit) || s.limit < 1 || s.limit > 25 || day(s.until) - day(s.since) !== 6 * 86400000) throw new Error("meta_selection_invalid");
}
export function metaAccountUrl(accountId: string) {
  if (!/^[0-9]{1,30}$/.test(accountId)) throw new Error("meta_account_invalid");
  const url = new URL(`https://graph.facebook.com/${FOUNDER_META_API_VERSION}/act_${accountId}`);
  url.searchParams.set("fields", "id,account_id,currency,timezone_name"); return url.href;
}
export function metaInsightsUrl(accountId: string, s: MetaReadSelection) {
  validateMetaSelection(s); const url = new URL(`${metaAccountUrl(accountId).split("?")[0]}/insights`);
  url.searchParams.set("fields", "impressions,clicks,spend,account_currency,date_start,date_stop");
  url.searchParams.set("time_range", JSON.stringify({ since:s.since, until:s.until })); url.searchParams.set("limit",String(s.limit)); return url.href;
}
const record=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=="object"||Array.isArray(v))throw new Error("meta_shape_invalid");return v as Record<string,unknown>;};
export function projectMetaAccount(accountId:string, wire:unknown) { metaAccountUrl(accountId);const r=record(wire);
 if(r.id!==`act_${accountId}`||r.account_id!==accountId||typeof r.currency!=="string"||!/^[A-Z]{3}$/.test(r.currency)||typeof r.timezone_name!=="string"||!/^[-A-Za-z0-9_+/.]{1,80}$/.test(r.timezone_name))throw new Error("meta_account_unconfirmed");
 return {currency:r.currency,timezoneName:r.timezone_name}; }
export function projectMetaInsights(s:MetaReadSelection,currency:string,wire:unknown){validateMetaSelection(s);const page=record(wire);if(!Array.isArray(page.data)||page.data.length>s.limit)throw new Error("meta_shape_invalid");
 const rows=page.data.map(item=>{const r=record(item);if(typeof r.impressions!=="string"||!/^\d{1,20}$/.test(r.impressions)||typeof r.clicks!=="string"||!/^\d{1,20}$/.test(r.clicks)||typeof r.spend!=="string"||!/^\d{1,18}(?:\.\d{1,6})?$/.test(r.spend)||r.account_currency!==currency||r.date_start!==s.since||r.date_stop!==s.until)throw new Error("meta_shape_invalid");return {impressions:r.impressions,clicks:r.clicks,spend:r.spend,accountCurrency:currency,dateStart:s.since,dateStop:s.until};});
 return {rows,selection:s,captureCompleteness:"bounded-response" as const,datasetCompleteness:"unknown" as const,businessSuccess:"unverified" as const}; }
