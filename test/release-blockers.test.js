import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { askRoutingJev } from '../src/router/jev.js'
import { AccountingStore } from '../src/execution/accountingStore.js'
import { executeRoutedTask, resumeRoutedTask } from '../src/mcp/tools-v04.js'
import { registerProvider, clearProviders } from '../src/providers/registry-v12.js'
import { normalizeResult } from '../src/providers/base.js'
import { openAIResponseBody } from '../src/providers/openai.js'
import { chatBody } from '../src/providers/chat.js'
import { createServer } from '../src/mcp/server.js'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { taskIdentityFromContext } from '../src/execution/taskIdentity.js'

const tempStore=async(env={})=>new AccountingStore({file:path.join(await mkdtemp(path.join(os.tmpdir(),'release-blockers-')),'ledger.json'),env})
const report={name:'report_result',arguments:JSON.stringify({status:'complete',findings:['done'],artifact:'patch',evidence:['approved'],tests:['mock'],blockers:[]})}
const externalRoute={provider:'xai',model:'grok-4.6',effort:'high'}

test('Jev advice fails closed before dispatch without both owner gate and conservative bound',async()=>{
  let calls=0;const fetchImpl=async()=>{calls++;throw new Error('must not call')}
  const gated=await askRoutingJev({task:'bounded',risk:'normal',rootCause:null,evidence:[]},{env:{TYPESAFE_API_KEY:'x'},fetchImpl})
  const unpriced=await askRoutingJev({task:'bounded',risk:'normal',rootCause:null,evidence:[]},{env:{TYPESAFE_API_KEY:'x',HARNESS_ENABLE_PAID_EXECUTION:'true'},fetchImpl})
  assert.equal(gated.reason,'jev-paid-execution-owner-gate-disabled');assert.equal(unpriced.reason,'jev-call-cost-bound-missing-or-invalid');assert.equal(calls,0)
})

test('one Jev reservation covers retry and charges the operator bound to the derived task',async()=>{
  let calls=0;const env={TYPESAFE_API_KEY:'x',HARNESS_ENABLE_PAID_EXECUTION:'true',HARNESS_JEV_CALL_COST_USD:'.07'},store=await tempStore(env)
  const fetchImpl=async()=>{calls++;if(calls===1)return{ok:false,status:429,headers:{get:()=>0}};return{ok:true,status:200,headers:{get:()=>null},json:async()=>({model:'jev',answers:{},usage:{input_tokens:2,output_tokens:1}})}}
  const result=await askRoutingJev({task:'same identity',risk:'normal',rootCause:'known',evidence:[]},{env,store,fetchImpl,workspace:'repo',maxRetries:1})
  const usage=await store.getUsage(result.taskId)
  assert.equal(result.available,true);assert.equal(result.taskId,taskIdentityFromContext({task:'same identity',rootCause:'known'},'repo'));assert.equal(calls,2);assert.equal(usage.task.auxiliaryStarts,1);assert.equal(usage.task.actualCostUsd,.07);assert.equal(usage.daily.actualCostUsd,.07)
})

test('service resumes request_context with the same task and attempt history',async()=>{
  const calls=[];clearProviders();registerProvider('xai',{execute:async query=>{calls.push(query);return calls.length===1
    ?normalizeResult({provider:'xai',model:query.model,role:query.role,usage:{inputTokens:10,outputTokens:4},metadata:{responseId:'resp-1',continuationRequired:true,toolCalls:[{name:'request_context',arguments:JSON.stringify({paths:['src/a.js'],reason:'need direct caller'})}]}})
    :normalizeResult({provider:'xai',model:query.model,role:query.role,usage:{inputTokens:7,outputTokens:3},metadata:{responseId:'resp-2',toolCalls:[report]}})}})
  const env={HARNESS_ENABLE_PAID_EXECUTION:'true',HARNESS_MAX_INPUT_TOKENS:'1000',HARNESS_MAX_OUTPUT_TOKENS:'100',HARNESS_MAX_DELEGATIONS:'2'},store=await tempStore(env)
  const first=await executeRoutedTask({task:'implement bounded fix',files:['src/a.js'],requestedRoute:externalRoute},{useJev:false,env,store})
  const resumed=await resumeRoutedTask({jobId:first.execution.job.id,approvedEvidence:{evidence:['src/a.js:12 calls helper with stale input'],files:['src/a.js']}},{env,store})
  const usage=await store.getUsage(first.execution.taskId)
  assert.equal(first.execution.result.completion.reason,'bounded-context-requested');assert.equal(resumed.result.structured.status,'complete')
  assert.equal(resumed.taskId,first.execution.taskId);assert.equal(resumed.job.parentJobId,first.execution.job.id);assert.equal(calls[1].previousResponseId,'resp-1')
  assert.equal(usage.task.starts,1);assert.equal(usage.task.auxiliaryStarts,1);assert.equal(usage.task.inputTokens,17);assert.equal(usage.task.outputTokens,7)
  const replay=await resumeRoutedTask({jobId:first.execution.job.id,approvedEvidence:{evidence:['different caller input must not create another call']}},{env,store})
  assert.equal(replay.reason,'idempotent-replay');assert.equal(calls.length,2)
})

test('continuation rejects unsafe evidence and provider bodies preserve bounded semantics',async()=>{
  clearProviders();registerProvider('xai',{execute:async query=>normalizeResult({provider:'xai',model:query.model,role:query.role,usage:{inputTokens:1,outputTokens:1},metadata:{responseId:'r',continuationRequired:true,toolCalls:[{name:'request_context',arguments:JSON.stringify({paths:['src/a.js'],reason:'need it'})}]}})})
  const env={HARNESS_ENABLE_PAID_EXECUTION:'true'},store=await tempStore(env),first=await executeRoutedTask({task:'bounded continuation',requestedRoute:externalRoute},{useJev:false,env,store})
  const denied=await resumeRoutedTask({jobId:first.execution.job.id,approvedEvidence:{files:['../../.env']}},{env,store})
  assert.equal(denied.reason,'approved-evidence-unsafe-path')
  const responseBody=openAIResponseBody({model:'m',effort:'high',budget:{maxOutputTokens:20},previousResponseId:'resp',continuation:{request:{reason:'x'},approvedEvidence:{evidence:['ok']}}})
  const chat=chatBody({model:'m',effort:'high',budget:{maxOutputTokens:20},task:'t',context:{},continuation:{request:{reason:'x'},approvedEvidence:{evidence:['ok']}}})
  assert.equal(responseBody.previous_response_id,'resp');assert.equal(responseBody.input.length,1);assert.equal(chat.messages.length,4);assert.match(chat.messages[3].content,/approvedEvidence/)
})

test('MCP request_context to approved evidence to complete report is resumable end to end',async()=>{
  let calls=0
  const adapter={execute:async query=>{calls++;return calls===1
    ?normalizeResult({provider:'xai',model:query.model,role:query.role,usage:{inputTokens:3,outputTokens:2},metadata:{responseId:'mcp-response-1',continuationRequired:true,toolCalls:[{name:'request_context',arguments:JSON.stringify({paths:['src/mcp.js'],reason:'need approved excerpt'})}]}})
    :normalizeResult({provider:'xai',model:query.model,role:query.role,usage:{inputTokens:2,outputTokens:2},metadata:{toolCalls:[report]}})}}
  const env={HARNESS_ENABLE_PAID_EXECUTION:'true',HARNESS_MAX_INPUT_TOKENS:'1000',HARNESS_MAX_OUTPUT_TOKENS:'100'},store=await tempStore(env),server=createServer({env,store,useJev:false,providers:{xai:adapter}})
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair(),pending=new Map();let nextId=1
  clientTransport.onmessage=message=>{if(message.id!=null&&pending.has(message.id)){const {resolve,reject}=pending.get(message.id);pending.delete(message.id);message.error?reject(new Error(JSON.stringify(message.error))):resolve(message.result)}}
  await server.connect(serverTransport);await clientTransport.start()
  const request=(method,params={})=>new Promise((resolve,reject)=>{const id=nextId++;pending.set(id,{resolve,reject});void clientTransport.send({jsonrpc:'2.0',id,method,params})})
  try{
    await request('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'release-test',version:'1'}})
    await clientTransport.send({jsonrpc:'2.0',method:'notifications/initialized',params:{}})
    const firstCall=await request('tools/call',{name:'execute_routed_task',arguments:{task:'implement MCP continuation',files:['src/mcp.js'],requestedRoute:externalRoute}}),first=JSON.parse(firstCall.content[0].text)
    const secondCall=await request('tools/call',{name:'resume_routed_task',arguments:{jobId:first.execution.job.id,approvedEvidence:{evidence:['src/mcp.js:20 has the required direct call'],files:['src/mcp.js']}}}),second=JSON.parse(secondCall.content[0].text)
    assert.equal(first.execution.result.completion.reason,'bounded-context-requested');assert.equal(second.result.structured.status,'complete');assert.equal(second.taskId,first.execution.taskId);assert.equal(calls,2)
  }finally{await clientTransport.close()}
})
