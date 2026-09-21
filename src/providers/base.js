export class ProviderError extends Error {
  constructor(provider, code, { status=null, retryable=false, uncertainBilling=false }={}) {
    super(`${provider}:${code}`); this.name='ProviderError'; this.provider=provider; this.code=code
    this.status=status; this.retryable=retryable; this.uncertainBilling=uncertainBilling
  }
}
export class ProviderAdapter{constructor(name){this.name=name}async execute(){throw new Error(`${this.name}: execute not implemented`)}}
export function normalizeResult({provider,model,role,output='',usage={},finishReason=null,metadata={}}){const usageComplete=Number.isFinite(Number(usage.inputTokens))&&Number.isFinite(Number(usage.outputTokens)),a=Number(usage.inputTokens||0),b=Number(usage.outputTokens||0);return{provider,model,role,output:String(output),usage:{inputTokens:a,outputTokens:b,totalTokens:Number(usage.totalTokens||a+b)},finishReason,metadata:{...metadata,usageComplete}}}
export function createTimeoutSignal(timeoutMs=30000, upstream) {
  const controller=new AbortController(), onAbort=()=>controller.abort(upstream?.reason)
  if(upstream?.aborted)onAbort();else upstream?.addEventListener?.('abort',onAbort,{once:true})
  const timer=setTimeout(()=>controller.abort(new Error('provider-timeout')),timeoutMs)
  return { signal:controller.signal, cleanup(){clearTimeout(timer);upstream?.removeEventListener?.('abort',onAbort)} }
}
export async function checkedJson(provider, response) {
  if(!response.ok)throw new ProviderError(provider,`http-${response.status}`,{status:response.status,retryable:[408,429,500,502,503,504].includes(response.status),uncertainBilling:response.status===408||response.status>=500})
  try{return await response.json()}catch{throw new ProviderError(provider,'invalid-json',{status:response.status,uncertainBilling:true})}
}
export function providerFailure(provider,error,signal){
  if(error instanceof ProviderError)return error
  if(signal?.aborted)return new ProviderError(provider,signal.reason?.message==='provider-timeout'?'timeout':'cancelled',{uncertainBilling:true})
  return new ProviderError(provider,'network-error',{retryable:true,uncertainBilling:true})
}
export const delegateTools = [{type:'function',name:'request_context',description:'Request one bounded additional context packet.',parameters:{type:'object',properties:{paths:{type:'array',items:{type:'string'},maxItems:6},reason:{type:'string'}},required:['reason'],additionalProperties:false}},{type:'function',name:'report_result',description:'Return the completed bounded result. Reviewers must also return artifact:null and the review coverage/verdict.',parameters:{type:'object',properties:{status:{type:'string',enum:['complete','incomplete','blocked']},findings:{type:'array',items:{type:'string'}},artifact:{type:['string','null']},evidence:{type:'array',items:{type:'string'}},tests:{type:'array',items:{type:'string'}},blockers:{type:'array',items:{type:'string'}},review:{type:'object',properties:{artifactDigest:{type:'string',pattern:'^[a-f0-9]{64}$'},accepted:{type:'boolean'},coveredFiles:{type:'array',items:{type:'string'},maxItems:8}},required:['artifactDigest','accepted','coveredFiles'],additionalProperties:false}},required:['status','findings','evidence','tests','blockers'],additionalProperties:false}}]
