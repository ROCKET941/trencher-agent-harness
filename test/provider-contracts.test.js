import test from 'node:test'
import assert from 'node:assert/strict'
import {OpenAIProvider} from '../src/providers/openai.js'
import {XAIProvider} from '../src/providers/xai.js'
import {DeepSeekProvider} from '../src/providers/deepseek.js'
import {KimiProvider} from '../src/providers/kimi.js'
import {getProviderStatus} from '../src/providers/status.js'
import {listModels,validateModel} from '../src/providers/catalog.js'

const query={role:'engineer',model:'gpt-5.6-terra',effort:'high',task:'bounded',context:{files:['src/a.js']},instruction:'work',budget:{maxOutputTokens:25}}
const response=value=>({ok:true,status:200,json:async()=>value})

test('verified catalog separates native host models from priced API delegates',()=>{
  assert.equal(listModels().length,8)
  assert.equal(validateModel({provider:'deepseek',model:'deepseek-flash',effort:'medium'}).allowed,false)
  assert.equal(validateModel({provider:'openai',model:'gpt-5.6-sol',effort:'max'}).allowed,true)
  assert.ok(listModels().every(model=>model.verifiedAt==='2026-09-20'&&model.source.startsWith('https://')))
  assert.ok(listModels({provider:'openai'}).every(model=>model.executionMode==='native_host'&&model.inputPerMTok===null&&model.outputPerMTok===null))
  assert.ok(listModels({provider:'xai'}).every(model=>model.executionMode==='external_api'))
})

test('OpenAI Responses request and response contract',async()=>{
  let url,request
  const adapter=new OpenAIProvider({env:{OPENAI_API_KEY:'secret',OPENAI_BASE_URL:'https://openai.test'},fetchImpl:async(u,r)=>{url=u;request=r;return response({id:'r1',status:'completed',output_text:'ok',usage:{input_tokens:3,output_tokens:2,total_tokens:5}})}})
  const result=await adapter.execute(query)
  const body=JSON.parse(request.body)
  assert.equal(url,'https://openai.test/v1/responses');assert.equal(request.headers.authorization,'Bearer secret')
  assert.equal(body.reasoning.effort,'high');assert.equal(body.max_output_tokens,25);assert.ok(body.tools.some(tool=>tool.name==='request_context'))
  assert.equal(result.output,'ok');assert.equal(result.usage.totalTokens,5)
})

test('xAI Responses contract uses xAI endpoint without substituting model',async()=>{
  let url,body
  const adapter=new XAIProvider({env:{XAI_API_KEY:'x',XAI_BASE_URL:'https://x.test'},fetchImpl:async(u,r)=>{url=u;body=JSON.parse(r.body);return response({id:'x1',status:'completed',output:[],usage:{}})}})
  await adapter.execute({...query,model:'grok-4.6',effort:'xhigh'})
  assert.equal(url,'https://x.test/v1/responses');assert.equal(body.model,'grok-4.6');assert.equal(body.reasoning.effort,'xhigh')
})

test('DeepSeek Chat contract maps usage and canonical reasoning effort',async()=>{
  let url,body
  const adapter=new DeepSeekProvider({env:{DEEPSEEK_API_KEY:'d'},fetchImpl:async(u,r)=>{url=u;body=JSON.parse(r.body);return response({id:'d1',choices:[{message:{content:'done'},finish_reason:'stop'}],usage:{prompt_tokens:7,completion_tokens:4,total_tokens:11}})}})
  const result=await adapter.execute({...query,model:'deepseek-v4-pro',effort:'max'})
  assert.equal(url,'https://api.deepseek.com/chat/completions');assert.equal(body.reasoning_effort,'max');assert.equal(body.model,'deepseek-v4-pro');assert.equal(result.usage.totalTokens,11)
})

test('Kimi Chat contract accepts standard key and Moonshot alias',async()=>{
  for(const env of [{KIMI_API_KEY:'k'},{MOONSHOT_API_KEY:'m'}]){let auth;const adapter=new KimiProvider({env,fetchImpl:async(_u,r)=>{auth=r.headers.authorization;return response({id:'k1',choices:[{message:{content:'done'},finish_reason:'stop'}],usage:{}})}});await adapter.execute({...query,model:'kimi-k3',effort:'high'});assert.match(auth,/^Bearer [km]$/)}
})

test('provider errors redact keys and response bodies',async()=>{
  const adapter=new OpenAIProvider({env:{OPENAI_API_KEY:'super-secret'},fetchImpl:async()=>({ok:false,status:401,json:async()=>({secret:'body-secret'})})})
  await assert.rejects(()=>adapter.execute(query),error=>{assert.equal(error.message,'openai:http-401');assert.doesNotMatch(error.message,/super-secret|body-secret/);return true})
})

test('HTTP 408 is treated as uncertain billing',async()=>{
  const adapter=new OpenAIProvider({env:{OPENAI_API_KEY:'x'},fetchImpl:async()=>({ok:false,status:408,json:async()=>({})})})
  await assert.rejects(()=>adapter.execute(query),error=>{assert.equal(error.code,'http-408');assert.equal(error.uncertainBilling,true);return true})
})

test('provider timeout aborts the request with a bounded sanitized error',async()=>{
  const adapter=new OpenAIProvider({env:{OPENAI_API_KEY:'x'},timeoutMs:5,fetchImpl:async(_url,request)=>new Promise((_resolve,reject)=>request.signal.addEventListener('abort',()=>reject(request.signal.reason),{once:true}))})
  await assert.rejects(()=>adapter.execute(query),error=>{assert.equal(error.code,'timeout');assert.equal(error.uncertainBilling,true);return true})
})

test('provider status intersects account-visible catalog and never returns key',async()=>{
  const result=await getProviderStatus('xai',{env:{XAI_API_KEY:'private'},refresh:true,fetchImpl:async()=>response({data:[{id:'grok-4.6'},{id:'other'}]})})
  assert.deepEqual(result.eligible,['grok-4.6']);assert.equal(result.keyEnv,'XAI_API_KEY');assert.equal(JSON.stringify(result).includes('private'),false)
})

test('OpenAI provider status is native host managed and never contacts the API',async()=>{
  let calls=0
  const result=await getProviderStatus('openai',{env:{OPENAI_API_KEY:'must-not-be-used'},refresh:true,fetchImpl:async()=>{calls++;throw new Error('must not call')}})
  assert.equal(result.executionMode,'native_host');assert.equal(result.reason,'native-host-managed-no-api-key-required');assert.equal(result.keyEnv,null);assert.equal(calls,0)
})
