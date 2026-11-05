import { ReadGateError, type ReadOperationId } from "./types.js";

/** User data is only strict variables. Query text, endpoints, headers and filters are never inputs. */
export const LINEAR_TEAM_QUERY = "query ShibaTeamIssues($id: String!, $first: Int!, $includeArchived: Boolean!) { team(id: $id) { id name issues(first: $first, includeArchived: $includeArchived) { nodes { id identifier title url updatedAt state { id name type } } pageInfo { hasNextPage endCursor } } } }";
const text={type:"string",minLength:1,maxLength:200};
export const OPERATION_SCHEMAS: Record<ReadOperationId,Record<string,unknown>> = {
  "figma.get_file_metadata":{type:"object",additionalProperties:false,required:["fileKey"],properties:{fileKey:{...text,pattern:"^[A-Za-z0-9_-]+$"}}},
  "linear.list_issues_by_team_id":{type:"object",additionalProperties:false,required:["team_id","first","include_archived"],properties:{team_id:text,first:{type:"integer",minimum:1,maximum:25},include_archived:{type:"boolean"}}},
  "github.list_pull_requests":{type:"object",additionalProperties:false,required:["owner","repo","perPage","state"],properties:{owner:{...text,pattern:"^(?!\\.{1,2}$)[A-Za-z0-9_.-]+$"},repo:{...text,pattern:"^(?!\\.{1,2}$)[A-Za-z0-9_.-]+$"},perPage:{type:"integer",minimum:1,maximum:25},state:{type:"string",enum:["open","closed","all"]}}},
};
function object(value: unknown): Record<string,unknown> {if(!value||typeof value!=="object"||Array.isArray(value))throw new ReadGateError("read_gate_arguments_invalid",400);return value as Record<string,unknown>;}
function exact(row:Record<string,unknown>,keys:string[]) {if(Object.keys(row).length!==keys.length||keys.some(key=>!Object.hasOwn(row,key)))throw new ReadGateError("read_gate_arguments_invalid",400);}
// biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control characters in untrusted fixed-read arguments.
function string(value:unknown,pattern?:RegExp) {if(typeof value!=="string"||value.length<1||value.length>200||value.trim()!==value||/[\u0000-\u001f]/u.test(value)||(pattern&&!pattern.test(value)))throw new ReadGateError("read_gate_arguments_invalid",400);return value;}
function count(value:unknown){if(!Number.isInteger(value)||Number(value)<1||Number(value)>25)throw new ReadGateError("read_gate_arguments_invalid",400);return Number(value);}
export function validateReadArguments(id:ReadOperationId,value:unknown):Record<string,unknown>{const row=object(value);
  if(id==="figma.get_file_metadata"){exact(row,["fileKey"]);return{fileKey:string(row.fileKey,/^[A-Za-z0-9_-]+$/)};}
  if(id==="linear.list_issues_by_team_id"){exact(row,["team_id","first","include_archived"]);if(typeof row.include_archived!=="boolean")throw new ReadGateError("read_gate_arguments_invalid",400);return{team_id:string(row.team_id),first:count(row.first),include_archived:row.include_archived};}
  if(id==="github.list_pull_requests"){exact(row,["owner","repo","perPage","state"]);if(!["open","closed","all"].includes(String(row.state)))throw new ReadGateError("read_gate_arguments_invalid",400);return{owner:string(row.owner,/^(?!\.{1,2}$)[A-Za-z0-9_.-]+$/),repo:string(row.repo,/^(?!\.{1,2}$)[A-Za-z0-9_.-]+$/),perPage:count(row.perPage),state:row.state};}
  throw new ReadGateError("read_gate_operation_unavailable",400);
}
export function providerRequest(id:ReadOperationId,args:Record<string,unknown>):{url:string;method:"GET"|"POST";body?:string}{
  if(id==="figma.get_file_metadata")return{url:`https://api.figma.com/v1/files/${encodeURIComponent(String(args.fileKey))}/meta`,method:"GET"};
  if(id==="linear.list_issues_by_team_id")return{url:"https://api.linear.app/graphql",method:"POST",body:JSON.stringify({query:LINEAR_TEAM_QUERY,variables:{id:args.team_id,first:args.first,includeArchived:args.include_archived}})};
  if(id==="github.list_pull_requests"){const valid=validateReadArguments(id,args);const url=new URL(`https://api.github.com/repos/${encodeURIComponent(String(valid.owner))}/${encodeURIComponent(String(valid.repo))}/pulls`);url.searchParams.set("per_page",String(valid.perPage));url.searchParams.set("state",String(valid.state));url.searchParams.set("page","1");return{url:url.href,method:"GET"};}
  throw new ReadGateError("read_gate_operation_unavailable",400);
}
