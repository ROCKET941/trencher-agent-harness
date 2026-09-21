import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { routeTask, reviewRoute, checkAction } from '../src/mcp/tools.js'
import { executeRoutedTask } from '../src/mcp/tools-v04.js'
import { createEvidencePacket } from '../src/context/evidencePacket.js'
import { PlanCache } from '../src/router/planCache.js'
import { AccountingStore } from '../src/execution/accountingStore.js'
import { registerProvider, clearProviders } from '../src/providers/registry-v12.js'
import { normalizeResult } from '../src/providers/base.js'
import { normalizeApprovedEvidence } from '../src/execution/boundedEvidence.js'
import { createServer } from '../src/mcp/server.js'
import { InMemoryTransport } from '@modelcontextprotocol/server'

const choice=(choice,confidence=.8)=>({type:'choice',choice,confidence})
const digest='a'.repeat(64)
const input={task:'Independently review the corrected clamp helper',risk:'normal',files:['src/clamp.js'],tests:['assert.equal(clamp(10,0,5),5) passed'],excerpts:[{path:'src/clamp.js',range:'1',content:'export const clamp=(x,lo,hi)=>Math.min(hi,Math.max(lo,x))'}],reviewContext:{artifactDigest:digest,commanderAgentId:'commander',implementationProviders:['openai'],changedFiles:['src/clamp.js'],evidenceComplete:true}}
async function fixture(answers={reviewer:choice('kimi:kimi-k3',.55),effort:choice('high')}){
  const env={TYPESAFE_API_KEY:'mock',KIMI_API_KEY:'mock',DEEPSEEK_API_KEY:'mock',XAI_API_KEY:'mock',HARNESS_ENABLE_PAID_EXECUTION:'true',HARNESS_JEV_CALL_COST_USD:'.01'}
  const store=new AccountingStore({file:path.join(await mkdtemp(path.join(os.tmpdir(),'cross-review-')),'ledger.json'),env}),calls=[]
  return{calls,options:{env,store,planCache:new PlanCache(),useCache:false,fetchImpl:async(_url,request)=>{calls.push(JSON.parse(request.body));return{ok:true,json:async()=>({model:'jev-mock',answers,usage:{input_tokens:2}})}}}}
}
function provider(reportChanges={},metadata={}){
  const calls=[]
  return{calls,adapter:{execute:async request=>{
    calls.push(request)
    return normalizeResult({provider:request.provider,model:request.model,role:request.role,usage:{inputTokens:100,outputTokens:20},metadata:{toolCalls:[{name:'report_result',arguments:JSON.stringify({status:'complete',findings:[],artifact:null,evidence:['Compared supplied source and checks'],tests:['Host supplied test evidence; no local execution'],blockers:[],review:{artifactDigest:digest,accepted:true,coveredFiles:['src/clamp.js']},...reportChanges})}],...metadata}})
  }}}
}
function commitFor(plan,job){return{reviewDecisionId:plan.routingDecision.decisionId,artifactDigest:digest,commander:{agentId:'commander',provider:'openai',model:'gpt-6-astra',effort:'xhigh',accepted:true},review:{agentId:`job:${job.id}`,jobId:job.id,provider:plan.route.provider,model:plan.route.model,effort:plan.route.effort,artifactDigest:digest,fresh:true,readOnly:true,accepted:true,blockers:[]},verification:{artifactDigest:digest,scopeVerified:true,checks:['tests','build','typecheck','lint'].map(name=>({name,status:'passed',evidence:'Verified exact artifact locally'}))}}}

test('complete Astra-authored review selects each capable external model without a second lane confidence veto',async()=>{
  for(const target of ['kimi:kimi-k3','xai:grok-4.6','deepseek:deepseek-v4-pro']){
    const {options,calls}=await fixture({reviewer:choice(target,.55),effort:choice('high')})
    const plan=await reviewRoute(input,options)
    assert.equal(`${plan.route.provider}:${plan.route.model}`,target)
    assert.equal(calls.length,1);assert.deepEqual(Object.keys(calls[0].questions),['reviewer','effort'])
    assert.equal(calls[0].state.excerpts[0].content,input.excerpts[0].content)
    assert.equal(plan.delegation.policy.readOnly,true);assert.equal(plan.review.required,false)
    assert.equal(plan.route.modelSelectionSource,'jev');assert.equal(plan.routingDecision.handoff,null)
    assert.equal(plan.routingDecision.dispatch.tool,'execute_routed_task')
  }
})

test('legacy, externally authored, incomplete, screened and oversized reviews retain independent native fallback',async()=>{
  const changes=[
    {reviewContext:{artifactDigest:digest,commanderAgentId:'commander'}},
    {reviewContext:{...input.reviewContext,implementationProviders:['openai','kimi']}},
    {reviewContext:{...input.reviewContext,evidenceComplete:false}},
    {reviewContext:{...input.reviewContext,changedFiles:['src/missing.js']}},
    {reviewContext:{...input.reviewContext,changedFiles:[123]}},
    {excerpts:[]},{excerpts:[{path:'src/clamp.js',content:'a'.repeat(6001)}]},
    {excerpts:[{path:'../clamp.js',content:'unsafe'}]},
    {excerpts:[{path:'src/clamp.js',content:'Bearer exampleSecretCredential'}]},
    {reviewMode:'native'},
    {protectedBoundaries:Array.from({length:13},(_,index)=>`Required invariant ${index}`)}
  ]
  for(const change of changes){const {options,calls}=await fixture(),plan=await reviewRoute({...input,...change},options);assert.equal(plan.route.model,'gpt-6-astra');assert.equal(calls.length,0);assert.equal(plan.routingDecision.handoff.fresh,true)}
})

test('unavailable Jev, unavailable providers and malformed review advice fail back to native',async()=>{
  for(const answer of [choice('kimi:kimi-k3',2),choice('deepseek:deepseek-flash'),choice('openai:gpt-5.6-luna'),choice('invented'),{type:'noul',noul:1}]){
    const {options}=await fixture({reviewer:answer});assert.equal((await reviewRoute(input,options)).route.model,'gpt-6-astra')
  }
  for(const env of [{TYPESAFE_API_KEY:''},{HARNESS_ENABLE_PAID_EXECUTION:'false'},{KIMI_API_KEY:'',XAI_API_KEY:'',DEEPSEEK_API_KEY:''}]){
    const {options}=await fixture();Object.assign(options.env,env);assert.equal((await reviewRoute(input,options)).route.model,'gpt-6-astra')
  }
})

test('external acceptance requires real pinned server job, exact artifact, complete coverage and commander signoff',async()=>{
  const {options,calls}=await fixture(),mock=provider();clearProviders();registerProvider('kimi',mock.adapter)
  const plan=await reviewRoute(input,options),fake=commitFor(plan,{id:'invented'})
  assert.equal((await checkAction({action:'commit',commit:fake},options)).allowed,false)
  const run=await executeRoutedTask({decisionId:plan.routingDecision.decisionId},options)
  assert.equal(run.execution.executed,true);assert.equal(run.execution.job.review.accepted,true)
  assert.equal(run.execution.result.structured.review.artifactDigest,digest)
  const commit=commitFor(plan,run.execution.job)
  assert.equal((await checkAction({action:'commit',commit},options)).allowed,true)
  const mutations=[v=>v.commander.accepted=false,v=>v.review.jobId='invented',v=>v.artifactDigest='b'.repeat(64),v=>v.review.artifactDigest='b'.repeat(64),v=>v.review.agentId='commander',v=>v.review.provider='xai',v=>v.review.blockers=['bug'],v=>v.verification.checks[0].status='failed',v=>v.review.accepted=false]
  for(const mutate of mutations){const value=structuredClone(commit);mutate(value);assert.equal((await checkAction({action:'commit',commit:value,explicitlyAuthorized:true},options)).allowed,false)}
  const replay=await executeRoutedTask({decisionId:plan.routingDecision.decisionId},options)
  assert.equal(replay.execution.reason,'idempotent-replay');assert.equal(mock.calls.length,1);assert.equal(calls.length,1)
  assert.equal((await options.store.getUsage(run.execution.taskId)).task.inputTokens,102)
  const other=await reviewRoute({...input,excerpts:[{...input.excerpts[0],content:input.excerpts[0].content+'; // changed'}]},options)
  assert.equal((await checkAction({action:'commit',commit:{...commit,reviewDecisionId:other.routingDecision.decisionId}},options)).allowed,false)
})

test('blocked, incomplete, patched, wrong-digest and partial-coverage provider reports never authorize commit',async()=>{
  for(const report of [{status:'incomplete'},{blockers:['regression']},{artifact:'a patch'},{findings:'not an array'},{review:{artifactDigest:digest,accepted:true,coveredFiles:[]}},{review:{artifactDigest:'b'.repeat(64),accepted:true,coveredFiles:['src/clamp.js']}},{review:{artifactDigest:digest,accepted:false,coveredFiles:['src/clamp.js']}}]){
    const {options}=await fixture(),mock=provider(report);clearProviders();registerProvider('kimi',mock.adapter)
    const plan=await reviewRoute(input,options),run=await executeRoutedTask({decisionId:plan.routingDecision.decisionId},options)
    assert.equal(run.execution.job.review.accepted,false)
    assert.equal((await checkAction({action:'commit',commit:commitFor(plan,run.execution.job)},options)).allowed,false)
  }
})

test('single oversized review is stopped by preflight before provider invocation',async()=>{
  const {options}=await fixture(),mock=provider();clearProviders();registerProvider('kimi',mock.adapter)
  const plan=await reviewRoute(input,options),run=await executeRoutedTask({decisionId:plan.routingDecision.decisionId,budget:{maxEstimatedInputTokens:10}},options)
  assert.equal(run.execution.reason,'estimated-input-too-large');assert.equal(mock.calls.length,0)
})

test('relative preference uncertainty does not veto qualified reviewers or weaken eligibility and approval',async()=>{
  const {options}=await fixture({reviewer:choice('kimi:kimi-k3',.2)})
  const plan=await reviewRoute(input,options)
  assert.equal(plan.route.provider,'kimi');assert.equal(plan.route.modelSelectionReason,'jev-independent-cross-model-review')
  assert.equal(plan.routingDecision.selection.target.jev.confidence,.2)
  assert.equal((await checkAction({action:'commit',commit:commitFor(plan,{id:'invented'})},options)).allowed,false)
  assert.equal((await reviewRoute({...input,reviewContext:{...input.reviewContext,evidenceComplete:false}},options)).route.provider,'openai')
  for(const cutoff of ['.3','invalid','2','-1']){
    const {options}=await fixture({reviewer:choice('kimi:kimi-k3',.2)})
    options.env.JEV_REVIEW_MIN_CONFIDENCE=cutoff
    assert.equal((await reviewRoute(input,options)).route.provider,'openai')
  }
  for(const confidence of [null,'1',true,2,-1,NaN,Infinity]){
    const {options}=await fixture({reviewer:choice('kimi:kimi-k3',confidence)})
    assert.equal((await reviewRoute(input,options)).route.provider,'openai')
  }
})

test('source excerpts retain path identities, screen secrets and report size/count truncation',()=>{
  const packet=createEvidencePacket({task:'Read sources',excerpts:Array.from({length:9},(_,i)=>({path:`src/${i}.js`,content:'a'.repeat(7000)}))},{contextProfile:'tight'})
  assert.equal(packet.excerpts.length,3);assert.equal(packet.excerpts[0].path,'src/0.js');assert.equal(packet.excerpts[0].content.length,6000)
  assert.equal(packet.truncation.dropped.excerpts,6);assert.equal(packet.truncation.occurred,true)
  assert.equal(normalizeApprovedEvidence({excerpts:[{path:'../bad',content:'source'}]}).allowed,false)
  assert.equal(normalizeApprovedEvidence({excerpts:input.excerpts}).allowed,true)
})

test('complete five-file review fits normal instead of silently cutting coverage to tight',async()=>{
  const {options}=await fixture(),files=Array.from({length:5},(_,i)=>`src/${i}.js`)
  const plan=await reviewRoute({...input,files,excerpts:files.map(path=>({path,content:'export const value=1'})),reviewContext:{...input.reviewContext,changedFiles:files}},options)
  assert.equal(plan.policy.contextProfile,'normal');assert.equal(plan.packet.excerpts.length,5);assert.equal(plan.packet.truncation.occurred,false)
  assert.equal(plan.route.provider,'kimi')
})

test('a single scoped coding workstream carries its own excerpts and facts without parent context bleed',async()=>{
  const {options,calls}=await fixture({worker:choice('engineer'),execution_lane:choice('native_host'),native_target:choice('openai:gpt-6-astra'),effort:choice('high'),workstream_0_execution_lane:choice('external_api'),workstream_0_native_target:choice('openai:gpt-6-astra'),workstream_0_external_target:choice('kimi:kimi-k3'),workstream_0_effort:choice('high')})
  const plan=await routeTask({task:'Implement bounded helper while commander integrates',evidence:['unrelated parent facts'],workstreams:[{id:'helper',task:'Implement the clamp correction',rootCause:'Wrong bound',files:input.files,excerpts:input.excerpts,facts:[{claim:'Callers use finite numbers',source:'src/caller.js:8'}]}]},options)
  assert.equal(calls.length,1);const assignment=plan.routingDecision.parallel.assignments[0]
  assert.equal(assignment.effective.provider,'kimi');assert.deepEqual(assignment.delegation.context.excerpts,input.excerpts.map(x=>({...x})))
  assert.equal(assignment.delegation.context.facts.length,1);assert.equal(assignment.delegation.context.evidence.includes('unrelated parent facts'),false)
  assert.equal(plan.routingDecision.handoff.scope,'workstream-assignments')
})

test('MCP preserves additive source and review metadata through real protocol validation',async()=>{
  const {options}=await fixture(),server=createServer({...options,providers:{}}),[client,transport]=InMemoryTransport.createLinkedPair()
  let seq=0,pending=new Map();client.onmessage=m=>{if(m.id!=null){pending.get(m.id)?.(m);pending.delete(m.id)}}
  await server.connect(transport);await client.start()
  const call=(method,params)=>new Promise(resolve=>{const id=++seq;pending.set(id,resolve);void client.send({jsonrpc:'2.0',id,method,params})})
  try{
    await call('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}})
    await client.send({jsonrpc:'2.0',method:'notifications/initialized'})
    const response=await call('tools/call',{name:'review_route',arguments:input})
    assert.equal(response.error,undefined)
    const plan=JSON.parse(response.result.content[0].text)
    assert.equal(plan.route.provider,'kimi');assert.equal(plan.packet.reviewContext.evidenceComplete,true)
    assert.equal(plan.packet.excerpts[0].content,input.excerpts[0].content)
  }finally{await client.close();await server.close()}
})
