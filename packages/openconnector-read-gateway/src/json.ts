export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]));
  return value;
}
export async function digest(text: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,"0")).join("");
}
export async function hash(value: unknown) { return digest(JSON.stringify(canonical(value))); }
/** Bound awaiting even when a dependency ignores the abort signal; callers never retry the uncertain effect. */
export function abortable<T>(work:Promise<T>,signal:AbortSignal):Promise<T>{
  if(signal.aborted)return Promise.reject(signal.reason??new Error("read_gate_aborted"));
  return new Promise<T>((resolve,reject)=>{const stop=()=>reject(signal.reason??new Error("read_gate_aborted"));signal.addEventListener("abort",stop,{once:true});void work.then(value=>{signal.removeEventListener("abort",stop);if(signal.aborted)stop();else resolve(value);},error=>{signal.removeEventListener("abort",stop);reject(error);});});
}
export async function boundedBody(body: ReadableStream<Uint8Array> | null, limit: number, signal?:AbortSignal): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader=body.getReader(),parts:Uint8Array[]=[];let used=0;
  try { for(;;){signal?.throwIfAborted();const next=reader.read(),row=await(signal?abortable(next,signal):next);if(row.done)break;used+=row.value.length;if(used>limit)throw new Error("read_gate_body_limit");parts.push(row.value);} }
  finally {void reader.cancel().catch(()=>{});}
  const out=new Uint8Array(used);let at=0;for(const part of parts){out.set(part,at);at+=part.length;}return out;
}
