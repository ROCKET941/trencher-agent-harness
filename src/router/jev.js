const BASE='https://api.typesafe.ai', RETRYABLE=new Set([429,529])
const sleep=ms=>new Promise(r=>setTimeout(r,ms)); const n=(v,d)=>Number.isFinite(Number(v))?Number(v):d
export const jevConfigured=(env=process.env)=>Boolean(env.TYPESAFE_API_KEY)
export const normalizeChoice=a=>a?.type==='choice'?{choice:a.choice,probabilities:a.probabilities||{},confidence:n(a.confidence,0)}:null
export const normalizeNoul=a=>a?.type==='noul'?{probability:n(a.noul,0)}:null
function delay(res,i){const h=res.headers?.get?.('retry-after'),s=Number(h);return Number.isFinite(s)?s*1000:Math.min(2000,250*(2**i))}
export async function askJev({state,questions},options={}){
 const env=options.env||process.env;if(!jevConfigured(env))return{available:false,reason:'jev-not-configured'}
 const f=options.fetchImpl||globalThis.fetch, timeout=n(env.TYPESAFE_TIMEOUT_MS,5000), max=options.maxRetries??2
 for(let i=0;i<=max;i++){const c=new AbortController(),t=setTimeout(()=>c.abort(),timeout);try{
  const r=await f(`${BASE}/v1/systemone`,{method:'POST',signal:c.signal,headers:{'content-type':'application/json',authorization:`Bearer ${env.TYPESAFE_API_KEY}`},body:JSON.stringify({model:env.TYPESAFE_MODEL||'jev-latest',state,questions})})
  if(RETRYABLE.has(r.status)&&i<max){clearTimeout(t);await sleep(delay(r,i));continue}
  if(!r.ok)return{available:false,reason:`jev-http-${r.status}`,retries:i}
  const raw=await r.json();return{available:true,reason:'jev',model:raw.model,answers:raw.answers||{},usage:raw.usage||{},retries:i}
 }catch(e){if(i<max&&(e?.name==='AbortError'||e instanceof TypeError)){clearTimeout(t);await sleep(250*(2**i));continue}return{available:false,reason:e?.name==='AbortError'?'jev-timeout':'jev-network-error',retries:i}}finally{clearTimeout(t)}}
}
export async function askRoutingJev(p,o={}){const r=await askJev({state:{task:p.task,risk:p.risk,root_cause_known:Boolean(p.rootCause),evidence:p.evidence},questions:{worker:{type:'choice',instructions:'Choose the cheapest capable worker. Never downgrade high-risk unknown-root-cause work.',criteria:{scout:'Repository search and reconnaissance only.',engineer:'Bounded implementation with an established causal path.',deep_debugger:'Ambiguous high-risk root cause, financial correctness, concurrency, distributed state or execution.'}},expand_context:{type:'noul',instructions:'Is more repository context required?',criteria:{true:'More evidence is necessary.',false:'Current evidence is sufficient.'}},review_required:{type:'noul',instructions:'Should this change receive an independent bounded review?',criteria:{true:'Meaningful normal/high-risk change.',false:'Trivial low-risk work.'}}}},o);return r.available?{...r,worker:normalizeChoice(r.answers.worker),expandContext:normalizeNoul(r.answers.expand_context),reviewRequired:normalizeNoul(r.answers.review_required)}:r}
