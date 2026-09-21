import test from 'node:test'
import assert from 'node:assert/strict'
import {classifyRisk} from '../src/router/risk.js'
import {askRoutingJev} from '../src/router/jev.js'
import {createEvidencePacket} from '../src/context/evidencePacket.js'
import {planTask} from '../src/orchestrator.js'
import {authorizeAction} from '../src/policy/safety.js'
import {executeRoutedTask,providerReadiness} from '../src/mcp/tools-v04.js'
import {resolveBudget} from '../src/budget/executionBudget.js'
import {AccountingStore} from '../src/execution/accountingStore.js'
import {registerProvider,clearProviders} from '../src/providers/registry-v12.js'
import {normalizeResult} from '../src/providers/base.js'
import {mkdtemp} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const choice=(value,confidence=1)=>({type:'choice',choice:value,confidence,probabilities:{[value]:1}})
const noul=value=>({type:'noul',noul:value})
const report=(status='complete')=>({name:'report_result',arguments:JSON.stringify({status,findings:['ok'],artifact:'bounded',evidence:[],tests:[],blockers:status==='complete'?[]:['not complete']})})
const tempStore=async(env={})=>new AccountingStore({file:path.join(await mkdtemp(path.join(os.tmpdir(),'harness-routing-')),'ledger.json'),env})

test('exact caller search is not high risk because symbol contains swap',()=>assert.equal(classifyRisk('Find every caller of reconcileSwapFill').risk,'normal'))
test('actual swap execution remains high risk',()=>assert.equal(classifyRisk('Execute the swap with real funds').risk,'high'))

test('caller risk cannot downgrade deterministic safety',async()=>{
  const plan=await planTask({task:'Deploy wallet settlement code to production',risk:'low'},{useJev:false})
  assert.equal(plan.packet.risk,'high');assert.equal(plan.review.required,true);assert.equal(plan.route.role,'deep_debugger')
})

test('Jev uses one batched planning request and caches on policy/registry/context',async()=>{
  let calls=0,sent
  const fetchImpl=async(_url,request)=>{calls++;sent=JSON.parse(request.body);return{ok:true,status:200,headers:{get:()=>null},json:async()=>({model:'jev',answers:{task_type:choice('implementation'),complexity:choice('medium'),risk:choice('normal'),worker:choice('engineer'),target:choice('openai:gpt-6-astra:xhigh'),context_profile:choice('tight'),retrieval_mode:choice('adjacent'),expand_context:noul(0),parallel_required:noul(0),parallel_justification:choice('none'),verification:choice('integration'),review_required:noul(1)},usage:{}})}}
  const packet=createEvidencePacket({task:'unique batched plan 98127',files:['a.js']})
  const env={TYPESAFE_API_KEY:'x',XAI_API_KEY:'mock',DEEPSEEK_API_KEY:'mock',KIMI_API_KEY:'mock',HARNESS_ENABLE_PAID_EXECUTION:'true',HARNESS_JEV_CALL_COST_USD:'.01'},store=await tempStore(env),first=await askRoutingJev(packet,{env,store,fetchImpl,workspace:'w'}),second=await askRoutingJev(packet,{env,store,fetchImpl,workspace:'w'})
  assert.equal(calls,1);assert.equal(second.cacheHit,true);assert.ok(sent.questions.task_type);assert.ok(sent.questions.parallel_justification);assert.ok(sent.questions.verification);assert.ok(sent.state.registry_version)
  assert.ok(sent.questions.effort);assert.equal(Object.keys(sent.questions.native_target.criteria).length,1);assert.equal(Object.keys(sent.questions.external_target.criteria).length,3);assert.equal(Object.keys(sent.questions.execution_lane.criteria).length,2);assert.ok(sent.state.target_efforts['openai:gpt-6-astra'].includes('xhigh'))
  assert.equal(sent.state.target_execution_modes['openai:gpt-6-astra'],'native_host');assert.equal(sent.state.target_execution_modes['xai:grok-4.6'],'external_api')
  assert.equal(first.target.choice,'openai:gpt-6-astra:xhigh')
})

test('route exposes requested recommended effective and deterministic overrides',async()=>{
  const plan=await planTask({task:'wallet settlement mismatch',risk:'high',requestedRoute:{role:'scout',provider:'openai',model:'gpt-5.6-luna',effort:'low'}},{useJev:false})
  assert.equal(plan.routingDecision.requested.role,'scout');assert.equal(plan.routingDecision.effective.role,'deep_debugger');assert.ok(plan.routingDecision.overrides.length>0)
})

test('low-confidence Jev target falls back to Astra while strong independent parallel advice remains influential',async()=>{
  const fetchImpl=async()=>({ok:true,status:200,headers:{get:()=>null},json:async()=>({model:'jev-test',answers:{worker:choice('engineer',.31),target:choice('openai:gpt-6-astra:xhigh',.28),context_profile:choice('tight',.9),retrieval_mode:choice('adjacent',.9),expand_context:noul(0),parallel_required:noul(.86),parallel_justification:choice('independent'),review_required:noul(0)},usage:{}})})
  const env={...{TYPESAFE_API_KEY:'x',HARNESS_ENABLE_PAID_EXECUTION:'true',HARNESS_JEV_CALL_COST_USD:'.01'},JEV_MIN_CONFIDENCE:'.70',HARNESS_MAX_PARALLEL:'3'}
  const plan=await planTask({task:'implement three disjoint bounded components',files:['src/a.js','src/b.js','src/c.js']},{env,store:await tempStore(env),fetchImpl})
  assert.equal(plan.route.model,'gpt-6-astra');assert.equal(plan.route.effort,'xhigh');assert.equal(plan.routingDecision.selection.target.source,'deterministic-fallback')
  assert.equal(plan.routingDecision.selection.target.jev.confidence,.28);assert.equal(plan.routingDecision.selection.target.jev.accepted,false);assert.equal(plan.routingDecision.selection.target.jev.reason,'insufficient-confidence')
  assert.equal(plan.routingDecision.parallel.effective,3);assert.equal(plan.routingDecision.handoff.scope,'commander');assert.equal(plan.routingDecision.handoff.parentModelUnchanged,true)
  assert.equal(plan.routingDecision.handoff.orchestration.strategy,'commander');assert.equal(plan.routingDecision.handoff.orchestration.maxAgents,1);assert.equal(plan.routingDecision.planReuse.routeOncePerPhase,true)
})

test('an unapproved host model override cannot replace an available valid Jev target',async()=>{
  const fetchImpl=async()=>({ok:true,status:200,headers:{get:()=>null},json:async()=>({model:'jev-test',answers:{worker:choice('engineer',.9),target:choice('openai:gpt-6-astra:xhigh',.9),context_profile:choice('tight'),retrieval_mode:choice('adjacent'),expand_context:noul(0),parallel_required:noul(0),parallel_justification:choice('none'),review_required:noul(0)},usage:{}})})
  const env={TYPESAFE_API_KEY:'x',HARNESS_ENABLE_PAID_EXECUTION:'true',HARNESS_JEV_CALL_COST_USD:'.01'}
  const requestedRoute={provider:'xai',model:'grok-4.6',effort:'high'}
  const plan=await planTask({task:'implement one bounded module',rootCause:'known',requestedRoute},{env,store:await tempStore(env),fetchImpl,useCache:false})
  assert.equal(plan.route.model,'gpt-6-astra');assert.equal(plan.routingDecision.selection.target.source,'jev')
  assert.equal(plan.routingDecision.selection.target.requested.accepted,false);assert.equal(plan.routingDecision.selection.target.requested.reason,'jev-authoritative')
})

test('an explicitly authorized host target may override Jev within capability floors',async()=>{
  const fetchImpl=async()=>({ok:true,status:200,headers:{get:()=>null},json:async()=>({model:'jev-test',answers:{worker:choice('engineer'),target:choice('openai:gpt-6-astra:xhigh',.9),context_profile:choice('tight'),retrieval_mode:choice('adjacent'),expand_context:noul(0),parallel_required:noul(0),parallel_justification:choice('none'),review_required:noul(0)},usage:{}})})
  const env={TYPESAFE_API_KEY:'x',HARNESS_ENABLE_PAID_EXECUTION:'true',HARNESS_JEV_CALL_COST_USD:'.01'}
  const requestedRoute={provider:'xai',model:'grok-4.6',effort:'high'}
  const plan=await planTask({task:'implement an explicitly targeted module',rootCause:'known',requestedRoute,requestedRouteAuthorized:true},{env,store:await tempStore(env),fetchImpl,useCache:false})
  assert.equal(plan.route.model,'grok-4.6');assert.equal(plan.routingDecision.selection.target.source,'requested-route');assert.equal(plan.routingDecision.selection.target.requested.accepted,true)
})

test('overlapping host workstreams fail closed to a single worker',async()=>{
  const workstreams=[{id:'a',task:'change a',files:['src/shared.js']},{id:'b',task:'change b',files:['src/shared.js']}]
  const plan=await planTask({task:'implement bounded changes',workstreams},{useJev:false,env:{HARNESS_MAX_PARALLEL:'3'}})
  assert.equal(plan.routingDecision.parallel.nonOverlapping,false);assert.equal(plan.routingDecision.parallel.effective,1);assert.equal(plan.routingDecision.parallel.conflicts[0].file,'src/shared.js')
})

test('provider readiness treats native plan models as ready and reports missing external keys',async()=>{
  const result=await providerReadiness({}, {env:{XAI_API_KEY:'x'}})
  assert.equal(result.statuses.openai.ready,true);assert.equal(result.statuses.openai.executionMode,'native_host')
  assert.equal(result.statuses.xai.ready,true);assert.equal(result.statuses.deepseek.ready,false);assert.equal(result.statuses.kimi.ready,false)
})

test('untrusted model authorization never grants protected action',()=>{
  assert.equal(authorizeAction('deploy',{explicitlyAuthorized:true}).allowed,false)
  assert.equal(authorizeAction('deploy',{explicitlyAuthorized:true,authorizationSource:'trusted_host'}).allowed,true)
})

test('caller budgets cannot inflate server policy',()=>{
  const budget=resolveBudget({maxInputTokens:999999,maxOutputTokens:999999,maxParallel:99,maxAttempts:99},{HARNESS_MAX_INPUT_TOKENS:'100',HARNESS_MAX_OUTPUT_TOKENS:'50',HARNESS_MAX_PARALLEL:'2',HARNESS_MAX_ATTEMPTS:'2'})
  assert.deepEqual({input:budget.maxInputTokens,output:budget.maxOutputTokens,parallel:budget.maxParallel,attempts:budget.maxAttempts},{input:100,output:50,parallel:2,attempts:2})
})

test('API commander always fails closed under native host policy',async()=>{
  let calls=0;clearProviders();registerProvider('openai',{execute:async()=>{calls++;throw new Error('must not dispatch')}})
  const result=await executeRoutedTask({task:'implement x',commanderMode:'api',apiCommanderOptIn:true},{useJev:false,env:{HARNESS_ENABLE_API_COMMANDER:'true',HARNESS_ENABLE_PAID_EXECUTION:'true'}})
  assert.equal(result.reason,'api-commander-disabled-native-host-policy');assert.equal(result.execution,null);assert.equal(calls,0)
})

test('paid execution requires a trusted server-side owner gate',async()=>{
  const requestedRoute={provider:'xai',model:'grok-4.6',effort:'high'},result=await executeRoutedTask({task:'implement x',requestedRoute},{useJev:false,env:{}})
  assert.equal(result.reason,'paid-execution-owner-gate-disabled');assert.equal(result.target.executionMode,'external_api');assert.equal(result.execution,null)
})

test('native OpenAI route returns a ChatGPT plan handoff without provider invocation',async()=>{
  let calls=0;clearProviders();registerProvider('openai',{execute:async()=>{calls++;throw new Error('must not dispatch')}})
  const env={},result=await executeRoutedTask({task:'implement one host change'},{useJev:false,env,store:await tempStore(env)})
  assert.equal(result.reason,'native-host-agent-required');assert.equal(result.execution,null);assert.equal(result.target.executionMode,'native_host')
  assert.equal(result.handoff.billingSource,'chatgpt_plan');assert.equal(result.handoff.model,'gpt-6-astra');assert.equal(result.handoff.scope,'commander');assert.equal(result.handoff.parentModelUnchanged,true);assert.equal(calls,0)
})

test('host commander dispatches one explicitly selected external API worker',async()=>{
  const calls=[];clearProviders();registerProvider('xai',{execute:async query=>{calls.push([query.model,query.effort]);return normalizeResult({provider:'xai',model:query.model,role:query.role,usage:{inputTokens:1,outputTokens:1},metadata:{toolCalls:[report()]}})}})
  const env={HARNESS_ENABLE_PAID_EXECUTION:'true',HARNESS_MAX_INPUT_TOKENS:'12000',HARNESS_MAX_OUTPUT_TOKENS:'50',XAI_API_KEY:'test-key'}
  const requestedRoute={provider:'xai',model:'grok-4.6',effort:'high'},result=await executeRoutedTask({task:'implement one external change',requestedRoute},{useJev:false,env,store:await tempStore(env)})
  assert.deepEqual(calls,[['grok-4.6','high']]);assert.equal(result.target.executionMode,'external_api');assert.equal(result.execution.executed,true);assert.equal(result.reason,undefined)
})

test('packet reports count and entry truncation explicitly',()=>{
  const packet=createEvidencePacket({task:'x'.repeat(5000),files:Array.from({length:20},(_,i)=>`f${i}`)})
  assert.equal(packet.truncation.occurred,true);assert.equal(packet.truncation.dropped.files,14);assert.ok(packet.truncation.truncatedFields.includes('task'))
})
