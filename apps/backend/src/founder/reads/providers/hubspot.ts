import { z } from "zod";
import { founderHubSpotDecisionSchema, founderHubSpotDraftSchema } from "@shiba/shared";
import type { ReadAdapter } from "../adapter.js";
import { FOUNDER_HUBSPOT_EXECUTOR_DIGEST } from "../../founder-hubspot-generated.js";

/** Independently authored fixed HubSpot REST reads; no generic proxy, query, or write. */
const FOUNDER_HUBSPOT_SOURCE_PIN="native-hubspot-rest-v1";
export interface HubSpotReadSelection {dealIds:string[];invoiceIdProperty:string;paidAmountProperty:string;currencyProperty:string}
const property=(v:unknown)=>typeof v==="string"&&/^[a-z][a-z0-9_]{0,99}$/.test(v)&&!["constructor","prototype","__proto__"].includes(v);
function validateHubSpotSelection(s:HubSpotReadSelection){if(!s||typeof s!=="object"||Array.isArray(s)||Object.keys(s).sort().join(",")!=="currencyProperty,dealIds,invoiceIdProperty,paidAmountProperty"||!Array.isArray(s.dealIds)||s.dealIds.length<1||s.dealIds.length>25||s.dealIds.some(id=>typeof id!=="string"||!/^[0-9]{1,30}$/.test(id))||new Set(s.dealIds).size!==s.dealIds.length||![s.invoiceIdProperty,s.paidAmountProperty,s.currencyProperty].every(property)||new Set([s.invoiceIdProperty,s.paidAmountProperty,s.currencyProperty]).size!==3)throw new Error("hubspot_selection_invalid");}
function hubspotAccountUrl(id:string){if(!/^(?:0|[1-9][0-9]{0,15})$/.test(id)||!Number.isSafeInteger(Number(id)))throw new Error("hubspot_account_invalid");return "https://api.hubapi.com/account-info/v3/details";}
function hubspotBatchRequest(s:HubSpotReadSelection){validateHubSpotSelection(s);return {url:"https://api.hubapi.com/crm/v3/objects/0-3/batch/read",method:"POST" as const,body:JSON.stringify({inputs:s.dealIds.map(id=>({id})),properties:[s.invoiceIdProperty,s.paidAmountProperty,s.currencyProperty],propertiesWithHistory:[]})};}
const object=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=="object"||Array.isArray(v))throw new Error("hubspot_shape_invalid");return v as Record<string,unknown>;};
function projectHubSpotAccount(id:string,wire:unknown){hubspotAccountUrl(id);const row=object(wire);if(!Number.isSafeInteger(row.portalId)||String(row.portalId)!==id||typeof row.companyCurrency!=="string"||!/^[A-Z]{3}$/.test(row.companyCurrency)||typeof row.timeZone!=="string"||!/^[-A-Za-z0-9_+/.]{1,80}$/.test(row.timeZone))throw new Error("hubspot_account_unconfirmed");return{currency:row.companyCurrency,timezoneName:row.timeZone};}
function projectHubSpotSnapshot(s:HubSpotReadSelection,wire:unknown){validateHubSpotSelection(s);const page=object(wire);if(page.status!=="COMPLETE"||!Array.isArray(page.results)||page.results.length>s.dealIds.length||page.numErrors!==undefined&&page.numErrors!==0||page.errors!==undefined&&(!Array.isArray(page.errors)||page.errors.length!==0))throw new Error("hubspot_shape_invalid");const keys=[s.invoiceIdProperty,s.paidAmountProperty,s.currencyProperty],seen=new Set<string>();const records=page.results.map(value=>{const row=object(value),props=object(row.properties);if(typeof row.id!=="string"||!s.dealIds.includes(row.id)||seen.has(row.id)||keys.some(k=>!Object.hasOwn(props,k)))throw new Error("hubspot_shape_invalid");seen.add(row.id);const pairs=keys.map(key=>{const v=props[key];if(v!==null&&(typeof v!=="string"||new TextEncoder().encode(v).length>500))throw new Error("hubspot_shape_invalid");return[key,v] as const;});return{dealId:row.id,properties:Object.fromEntries(pairs) as Record<string,string|null>};});return{records,selection:s,captureCompleteness:"bounded-response" as const,datasetCompleteness:"unknown" as const,businessSuccess:"unverified" as const};}

const integer = z.number().int().safe();
const report = z.strictObject({
  format: z.literal("shiba.hubspot-read-report.v1"), accountId: z.string(), grantId: z.string(), revision: integer, contractDigest: z.string(), executorDigest: z.string(),
  apiVersion: z.literal("crm-v3"), currency: z.string().nullable(), timezoneName: z.string().nullable(), capturedAt: integer, capturedBytes: integer, notice: z.string(),
  capture: z.looseObject({ records: z.array(z.strictObject({ dealId: z.string().regex(/^[0-9]{1,30}$/), properties: z.record(z.string(), z.string().refine((value) => new TextEncoder().encode(value).length <= 500).nullable()) })), selection: z.looseObject({}), captureCompleteness: z.literal("bounded-response"), datasetCompleteness: z.literal("unknown"), businessSuccess: z.literal("unverified") }),
});

export const hubspot: ReadAdapter<HubSpotReadSelection, z.infer<typeof report>> = {
  id: "hubspot",
  origin: "https://api.hubapi.com",
  executorDigest: FOUNDER_HUBSPOT_EXECUTOR_DIGEST,
  wire: { route: "/api/founder-hubspot-reads", grantPrefix: "fhc_", receiptPrefix: "fhr_" },
  tables: { grants: "founder_hubspot_read_grants", receipts: "founder_hubspot_read_receipts" },
  env: { enabled: "FOUNDER_HUBSPOT_READS_ENABLED", key: "FOUNDER_HUBSPOT_CREDENTIAL_KEY" },
  seal: { aadDomain: "shiba.founder-hubspot.credential.v1", salt: "shiba.founder-hubspot.v1", info: "crm-token encryption", account: /^(?:0|[1-9][0-9]{0,15})$/, token: () => /^[A-Za-z0-9._~+\/-]{16,2048}$/ },
  schemas: { draft: founderHubSpotDraftSchema, decision: founderHubSpotDecisionSchema, report },
  scopeColumns: [],
  factColumns: ["currency", "timezone_name"],
  contract: { format: "shiba.hubspot-read-grant.v1", apiVersion: "crm-v3", upstreamPin: FOUNDER_HUBSPOT_SOURCE_PIN, attestation: { credentialAttestation: "creator-attests-token-appropriate-for-hubspot-deals-read" } },
  selection: (value) => { const selection = value as HubSpotReadSelection; validateHubSpotSelection(selection); return selection; },
  verifyRequest: (grant, secret) => ({ url: hubspotAccountUrl(grant.account_id), method: "GET", headers: { authorization: `Bearer ${secret}`, accept: "application/json" } }),
  acceptVerification: (grant, body) => projectHubSpotAccount(grant.account_id, body),
  readRequest: (selection, _grant, secret) => ({ ...hubspotBatchRequest(selection), headers: { authorization: `Bearer ${secret}`, accept: "application/json", "content-type": "application/json" } }),
  project: (selection, body, grant) => ({
    capture: projectHubSpotSnapshot(selection, body),
    extras: { currency: grant.currency, timezoneName: grant.timezone_name },
    notice: "Captured selected-deal response only; dataset completeness and business success are unknown. This is not a reconciliation or provider invoice.",
  }),
};
