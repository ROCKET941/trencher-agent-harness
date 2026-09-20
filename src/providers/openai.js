import { ProviderAdapter, normalizeResult, createTimeoutSignal, checkedJson, providerFailure, delegateTools } from './base.js'
import { providerConfig, resolveProviderKey } from './catalog.js'

export function openAIResponseBody(query) {
  const input=query.previousResponseId
    ?[{role:'user',content:[{type:'input_text',text:JSON.stringify({instruction:'Continue the same bounded task using only this approved evidence.',continuation:query.continuation})}]}]
    :[{role:'developer',content:[{type:'input_text',text:query.instruction||'Complete the bounded delegated task.'}]},{role:'user',content:[{type:'input_text',text:JSON.stringify({task:query.task,context:query.context})}]}]
  const body={model:query.model,input,reasoning:{effort:query.effort},max_output_tokens:query.budget.maxOutputTokens,tools:delegateTools,tool_choice:'auto'}
  if(query.previousResponseId)body.previous_response_id=query.previousResponseId
  return body
}
export function parseResponses(provider,query,value){
  const items=value.output||[], output=value.output_text??items.flatMap(item=>item.content||[]).filter(item=>item.type==='output_text').map(item=>item.text).join('\n')
  const toolCalls=items.filter(item=>item.type==='function_call').map(item=>({id:item.call_id||item.id,name:item.name,arguments:item.arguments}))
  return normalizeResult({provider,model:query.model,role:query.role,output,usage:{inputTokens:value.usage?.input_tokens,outputTokens:value.usage?.output_tokens,totalTokens:value.usage?.total_tokens},finishReason:value.status,metadata:{responseId:value.id,toolCalls,continuationRequired:toolCalls.some(call=>call.name==='request_context'),incomplete:value.status==='incomplete'}})
}
export class ResponsesProvider extends ProviderAdapter {
  constructor(name,{env=process.env,fetchImpl=globalThis.fetch,timeoutMs}={}){super(name);this.env=env;this.fetch=fetchImpl;this.timeoutMs=timeoutMs}
  prepare(query){return openAIResponseBody(query)}
  async execute(query){const {key}=resolveProviderKey(this.name,this.env);if(!key)throw new Error(`${this.name.toUpperCase()}_API_KEY not configured`);const cfg=providerConfig(this.name),base=(this.env[cfg.baseUrlEnv]||cfg.defaultBaseUrl).replace(/\/$/,'');const timed=createTimeoutSignal(this.timeoutMs||query.timeoutMs||30000,query.signal);try{const response=await this.fetch(`${base}/v1/responses`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${key}`},body:JSON.stringify(this.prepare(query)),signal:timed.signal});return parseResponses(this.name,query,await checkedJson(this.name,response))}catch(error){throw providerFailure(this.name,error,timed.signal)}finally{timed.cleanup()}}
}
export class OpenAIProvider extends ResponsesProvider { constructor(options={}){super('openai',options)} }
