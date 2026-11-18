type Mapping={invoiceIdProperty:string;paidAmountProperty:string;currencyProperty:string;amountUnit:"major-decimal"|"minor-integer";basisAttestation:"crm-property-represents-stripe-invoice-amount-paid"};
type Row={status:"matched_equal"|"matched_difference"|"duplicate_key"|"missing_key"|"invalid_key"|"unmatched_in_capture"|"uncaptured_deal"|"non_comparable";dealId:string|null;invoiceId:string|null;stripeStatus:string|null;invoiceCreated:number|null;currency:string|null;crmMinor:string|null;stripeMinor:string|null;differenceMinor:string|null;reason:string|null};
export interface CapturedDeal {dealId:string;properties:Record<string,string|null>}
export interface CapturedInvoice {id:string;currency:string;amountPaid:number;status:string|null;created:number;livemode:boolean}
const EXPS:Record<string,number>={USD:2,EUR:2,GBP:2,JPY:0};
function minor(raw:string,unit:Mapping["amountUnit"],exp:number):bigint|null {if(raw.length>50)return null;const match=/^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(raw);if(!match)return null;const fraction=match[3]??"";if(unit==="minor-integer"&&fraction||unit==="major-decimal"&&fraction.length>exp)return null;const digits=unit==="minor-integer"?match[2]!:match[2]!+fraction.padEnd(exp,"0");return BigInt((match[1]??"")+digits);}
/** Only input from checked stored source receipts; this function never fetches or accepts a mapping expression. */
export function computeFounderReconciliation(deals:CapturedDeal[],invoices:CapturedInvoice[],mapping:Mapping,selectedDealIds:string[]){
 if(deals.length>25||invoices.length>25||new Set(deals.map(x=>x.dealId)).size!==deals.length)throw new Error("reconciliation_source_invalid");
 const validId=(x:unknown):x is string=>typeof x==="string"&&/^in_[A-Za-z0-9]{1,200}$/.test(x),dealCounts=new Map<string,number>(),invoiceCounts=new Map<string,number>();
 for(const deal of deals){const key=deal.properties[mapping.invoiceIdProperty];if(validId(key))dealCounts.set(key,(dealCounts.get(key)??0)+1);}
 for(const invoice of invoices){if(!validId(invoice.id))throw new Error("reconciliation_source_invalid");invoiceCounts.set(invoice.id,(invoiceCounts.get(invoice.id)??0)+1);}
 const rows:Row[]=[],seen=new Set<string>();const totals=new Map<string,{count:number;crm:bigint;stripe:bigint}>();
 for(const deal of [...deals].sort((a,b)=>a.dealId.localeCompare(b.dealId))){const value=deal.properties[mapping.invoiceIdProperty],base={dealId:deal.dealId,invoiceId:validId(value)?value:null,stripeStatus:null,invoiceCreated:null,currency:null,crmMinor:null,stripeMinor:null,differenceMinor:null};
  if(value===null||value===undefined||value===""){rows.push({...base,status:"missing_key",reason:"missing_invoice_id"});continue;}
  if(!validId(value)){rows.push({...base,status:"invalid_key",reason:"invalid_invoice_id"});continue;}seen.add(value);
  if((dealCounts.get(value)??0)>1||(invoiceCounts.get(value)??0)>1){rows.push({...base,status:"duplicate_key",reason:"ambiguous_captured_invoice_id"});continue;}
  const invoice=invoices.find(v=>v.id===value);if(!invoice){rows.push({...base,status:"unmatched_in_capture",reason:"invoice_not_in_captured_page"});continue;}
  const rawCurrency=deal.properties[mapping.currencyProperty],currency=typeof rawCurrency==="string"&&/^[A-Za-z]{3}$/.test(rawCurrency)?rawCurrency.toUpperCase():null,invoiceCurrency=/^[a-z]{3}$/.test(invoice.currency)?invoice.currency.toUpperCase():null,rawAmount=deal.properties[mapping.paidAmountProperty],exp=currency?EXPS[currency]:undefined;
  const crm=typeof rawAmount==="string"&&exp!==undefined?minor(rawAmount,mapping.amountUnit,exp):null;
  if(!currency||exp===undefined||currency!==invoiceCurrency||crm===null||!Number.isSafeInteger(invoice.amountPaid)){rows.push({...base,stripeStatus:invoice.status,invoiceCreated:invoice.created,currency,status:"non_comparable",reason:"currency_or_amount_not_comparable"});continue;}
  const stripe=BigInt(invoice.amountPaid),difference=crm-stripe,group=totals.get(currency)??{count:0,crm:0n,stripe:0n};group.count++;group.crm+=crm;group.stripe+=stripe;totals.set(currency,group);
  rows.push({...base,stripeStatus:invoice.status,invoiceCreated:invoice.created,currency,crmMinor:crm.toString(),stripeMinor:stripe.toString(),differenceMinor:difference.toString(),status:difference===0n?"matched_equal":"matched_difference",reason:null});
 }
 for(const invoice of [...invoices].sort((a,b)=>a.id.localeCompare(b.id))){if(seen.has(invoice.id))continue;rows.push({status:(invoiceCounts.get(invoice.id)??0)>1?"duplicate_key":"unmatched_in_capture",dealId:null,invoiceId:invoice.id,stripeStatus:invoice.status,invoiceCreated:invoice.created,currency:null,crmMinor:null,stripeMinor:null,differenceMinor:null,reason:(invoiceCounts.get(invoice.id)??0)>1?"ambiguous_captured_invoice_id":"deal_not_in_captured_page"});}
 for(const dealId of [...selectedDealIds].sort()){if(!deals.some(v=>v.dealId===dealId))rows.push({status:"uncaptured_deal",dealId,invoiceId:null,stripeStatus:null,invoiceCreated:null,currency:null,crmMinor:null,stripeMinor:null,differenceMinor:null,reason:"selected_deal_not_returned"});}
 const perCurrency=[...totals.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([currency,v])=>({currency,matchedCount:v.count,crmMinor:v.crm.toString(),stripeMinor:v.stripe.toString(),differenceMinor:(v.crm-v.stripe).toString()}));return{rows,perCurrency};
}
