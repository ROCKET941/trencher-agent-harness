import test from 'node:test'
import assert from 'node:assert/strict'
import {classifyRisk} from '../src/router/risk.js'
import {askRoutingJev} from '../src/router/jev.js'
import {createEvidencePacket} from '../src/context/evidencePacket.js'
import {planTask} from '../src/orchestrator.js'
import {authorizeAction} from '../src/policy/safety.js'
import {executeRoutedTask} from '../src/mcp/tools-v04.js'
import {resolveBudget} from '../src/budget/executionBudget.js'
import {AccountingStore} from '../src/execution/accountingStore.js'
import {registerProvider,clearProviders} from '../src/providers/registry-v12.js'
import {normalizeResult} from '../src/providers/base.js'
import {mkdtemp} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const choice=value=>({type:'choice',choice:value,confidence:1,probabilities:{[value]:1}})
const noul=value=>({type:'noul',noul:value})
const report=(status='complete')=>({name:'report_result',arguments:JSON.stringify({status,findings:['ok'],artifact:'bounded',evidence:[],tests:[],blockers:status==='complete'?[]:['not complete']})})
const tempStore=async(env={})=>new AccountingStore({file:path.join(await mkdtemp(path.join(os.tmpdir(),'harness-api-commander-')),'ledger.json'),env})

test('exact caller search is not high risk because symbol contains swap',()=>assert.equal(classifyRisk('Find every caller of reconcileSwapFill').risk,'normal'))
test('actual swap execution remains high risk',()=>assert.equal(classifyRisk('Execute the swap with real funds').risk,'high'))

test('caller risk cannot downgrade deterministic safety',async()=>{
  const plan=await planTask({task:'Deploy wallet settlement code to production',risk:'low'},{useJev:false})
  assert.equal(plan.packet.risk,'high');assert.equal(plan.review.required,true);assert.equal(plan.route.role,'deep_debugger')
})

test('Jev uses one batched planning request and caches on policy/registry/context',async()=>{
  let calls=0,sent
  const fetchImpl=async(_url,request)=>{calls++;sent=JSON.parse(request.body);return{ok:true,status:200,headers:{get:()=>null},json:async()=>({model:'jev',answers:{task_type:choice('implementation'),complexity:choice('medium'),risk:choice('normal'),worker:choice('engineer'),target:choice('openai:gpt-5.6-terra:high'),context_profile:choice('tight'),retrieval_mode:choice('adjacent'),expand_context:noul(0),parallel_required:noul(0),parallel_justification:choice('none'),verification:choice('integration'),review_required:noul(1)},usage:{}})}}
  const packet=createEvidencePacket({task:'unique batched plan 98127',files:['a.js']})
  const env={TYPESAFE_API_KEY:'x',HARNESS_ENABLE_PAID_EXECUTION:'true',HARNESS_JEV_CALL_COST_USD:'.01'},store=await tempStore(env),first=await askRoutingJev(packet,{env,store,fetchImpl,workspace:'w'}),second=await askRoutingJev(packet,{env,store,fetchImpl,workspace:'w'})
  assert.equal(calls,1);assert.equal(second.cacheHit,true);assert.ok(sent.questions.task_type);assert.ok(sent.questions.parallel_justification);assert.ok(sent.questions.verification);assert.ok(sent.state.registry_version)
  assert.equal(first.target.choice,'openai:gpt-5.6-terra:high')
})

test('route exposes requested recommended effective and deterministic overrides',async()=>{
  const plan=await planTask({task:'wallet settlement mismatch',risk:'high',requestedRoute:{role:'scout',provider:'openai',model:'gpt-5.6-luna',effort:'low'}},{useJev:false})
  assert.equal(plan.routingDecision.requested.role,'scout');assert.equal(plan.routingDecision.effective.role,'deep_debugger');assert.ok(plan.routingDecision.overrides.length>0)
})

test('untrusted model authorization never grants protected action',()=>{
  assert.equal(authorizeAction('deploy',{explicitlyAuthorized:true}).allowed,false)
  assert.equal(authorizeAction('deploy',{explicitlyAuthorized:true,authorizationSource:'trusted_host'}).allowed,true)
})

test('caller budgets cannot inflate server policy',()=>{
  const budget=resolveBudget({maxInputTokens:999999,maxOutputTokens:999999,maxParallel:99,maxAttempts:99},{HARNESS_MAX_INPUT_TOKENS:'100',HARNESS_MAX_OUTPUT_TOKENS:'50',HARNESS_MAX_PARALLEL:'2',HARNESS_MAX_ATTEMPTS:'2'})
  assert.deepEqual({input:budget.maxInputTokens,output:budget.maxOutputTokens,parallel:budget.maxParallel,attempts:budget.maxAttempts},{input:100,output:50,parallel:2,attempts:2})
})

test('API commander requires explicit opt-in and rejects duplicate commander',async()=>{
  assert.equal((await executeRoutedTask({task:'implement x',commanderMode:'api'},{useJev:false})).reason,'api-commander-requires-explicit-opt-in')
  assert.equal((await executeRoutedTask({task:'implement x',commanderMode:'api',apiCommanderOptIn:true,hostCommanderActive:true},{useJev:false})).reason,'duplicate-host-and-api-commander')
  assert.equal((await executeRoutedTask({task:'implement x',commanderMode:'api',apiCommanderOptIn:true},{useJev:false,env:{}})).reason,'api-commander-owner-gate-disabled')
})

test('paid execution requires a trusted server-side owner gate',async()=>{
  const result=await executeRoutedTask({task:'implement x'},{useJev:false,env:{}})
  assert.equal(result.reason,'paid-execution-owner-gate-disabled');assert.equal(result.plan,null);assert.equal(result.execution,null)
})

test('API commander plans, routes one worker, then performs final Sol review with shared accounting',async()=>{
  const calls=[];clearProviders();registerProvider('openai',{execute:async query=>{calls.push({role:query.role,model:query.model,effort:query.effort,phase:query.context.phase});return normalizeResult({provider:'openai',model:query.model,role:query.role,usage:{inputTokens:10,outputTokens:5},metadata:{toolCalls:[report()]}})}})
  const env={HARNESS_ENABLE_API_COMMANDER:'true',HARNESS_ENABLE_PAID_EXECUTION:'true',HARNESS_MAX_PARALLEL:'1',HARNESS_MAX_INPUT_TOKENS:'12000',HARNESS_MAX_OUTPUT_TOKENS:'50'},store=await tempStore(env)
  const result=await executeRoutedTask({task:'implement a bounded change',commanderMode:'api',apiCommanderOptIn:true,taskId:'caller-controlled'},{useJev:false,env,store})
  assert.deepEqual(calls.map(call=>[call.model,call.effort,call.phase]),[['gpt-5.6-sol','xhigh','planning'],['gpt-5.6-terra','high',undefined],['gpt-5.6-sol','xhigh','final-review']])
  assert.equal(result.reason,undefined);assert.equal(result.execution.executed,true);assert.equal(result.review.executed,true)
  assert.equal(result.planning.taskId,result.execution.taskId);assert.equal(result.execution.taskId,result.review.taskId);assert.notEqual(result.execution.taskId,'caller-controlled')
  const usage=await store.getUsage(result.execution.taskId)
  assert.equal(usage.task.starts,1);assert.equal(usage.task.auxiliaryStarts,2);assert.ok(Math.abs(usage.task.actualCostUsd-.00036)<1e-12);assert.ok(Math.abs(usage.daily.actualCostUsd-.00036)<1e-12)
})

test('host commander mode dispatches exactly one routed worker',async()=>{
  const calls=[];clearProviders();registerProvider('openai',{execute:async query=>{calls.push([query.model,query.effort]);return normalizeResult({provider:'openai',model:query.model,role:query.role,usage:{inputTokens:1,outputTokens:1},metadata:{toolCalls:[report()]}})}})
  const env={HARNESS_ENABLE_PAID_EXECUTION:'true',HARNESS_MAX_INPUT_TOKENS:'12000',HARNESS_MAX_OUTPUT_TOKENS:'50'},result=await executeRoutedTask({task:'implement one host change',commanderMode:'host'},{useJev:false,env,store:await tempStore(env)})
  assert.deepEqual(calls,[['gpt-5.6-terra','high']]);assert.equal(result.execution.executed,true);assert.equal(result.planning,undefined);assert.equal(result.review,undefined)
})

test('API commander fails closed before worker or after an incomplete review',async()=>{
  for(const incompletePhase of ['planning','final-review']){
    const calls=[];clearProviders();registerProvider('openai',{execute:async query=>{calls.push(query.context.phase||'worker');const status=query.context.phase===incompletePhase?'incomplete':'complete';return normalizeResult({provider:'openai',model:query.model,role:query.role,usage:{inputTokens:1,outputTokens:1},metadata:{toolCalls:[report(status)]}})}})
    const env={HARNESS_ENABLE_API_COMMANDER:'true',HARNESS_ENABLE_PAID_EXECUTION:'true',HARNESS_MAX_INPUT_TOKENS:'12000',HARNESS_MAX_OUTPUT_TOKENS:'50'},result=await executeRoutedTask({task:`bounded ${incompletePhase}`,commanderMode:'api',apiCommanderOptIn:true},{useJev:false,env,store:await tempStore(env)})
    assert.equal(result.reason,incompletePhase==='planning'?'api-planning-incomplete':'api-review-incomplete')
    assert.deepEqual(calls,incompletePhase==='planning'?['planning']:['planning','worker','final-review'])
  }
})

test('API commander gates reject duplicate ownership before provider dispatch',async()=>{
  let calls=0;clearProviders();registerProvider('openai',{execute:async()=>{calls++;throw new Error('must not dispatch')}})
  const enabled={HARNESS_ENABLE_API_COMMANDER:'true',HARNESS_ENABLE_PAID_EXECUTION:'true'}
  assert.equal((await executeRoutedTask({task:'x',commanderMode:'api',apiCommanderOptIn:true,hostCommanderActive:true},{useJev:false,env:enabled})).reason,'duplicate-host-and-api-commander')
  assert.equal((await executeRoutedTask({task:'x',commanderMode:'api',apiCommanderOptIn:true},{useJev:false,env:{HARNESS_ENABLE_PAID_EXECUTION:'true'}})).reason,'api-commander-owner-gate-disabled')
  assert.equal(calls,0)
})

test('packet reports count and entry truncation explicitly',()=>{
  const packet=createEvidencePacket({task:'x'.repeat(5000),files:Array.from({length:20},(_,i)=>`f${i}`)})
  assert.equal(packet.truncation.occurred,true);assert.equal(packet.truncation.dropped.files,14);assert.ok(packet.truncation.truncatedFields.includes('task'))
})
