import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { planTask } from '../src/orchestrator.js'
import { routeTask, reviewRoute, checkAction, createDelegationRequest } from '../src/mcp/tools.js'
import { listModels } from '../src/providers/catalog.js'
import { PlanCache } from '../src/router/planCache.js'
import { AccountingStore } from '../src/execution/accountingStore.js'
import { executeDelegation, resumeDelegation } from '../src/execution/executor.js'
import { registerProvider, clearProviders } from '../src/providers/registry-v12.js'
import { routingModels } from '../src/router/jev.js'
import { normalizeResult } from '../src/providers/base.js'

const choice=(choice,confidence=.95)=>({type:'choice',choice,confidence})
const input={task:'Implement the supplied helper correction',rootCause:'Upper bound is wrong',files:['src/helper.js'],evidence:['export const clamp=(x,lo,hi)=>Math.min(lo,Math.max(lo,x))']}
async function fixture(answers={}) {
  const env={TYPESAFE_API_KEY:'mock',XAI_API_KEY:'mock',DEEPSEEK_API_KEY:'mock',KIMI_API_KEY:'mock',HARNESS_ENABLE_PAID_EXECUTION:'true',HARNESS_JEV_CALL_COST_USD:'.01'}
  const store=new AccountingStore({file:path.join(await mkdtemp(path.join(os.tmpdir(),'quality-first-')),'ledger.json'),env}),calls=[]
  return{calls,options:{env,store,planCache:new PlanCache(),useCache:false,fetchImpl:async(_url,request)=>{calls.push(JSON.parse(request.body));return{ok:true,json:async()=>({model:'jev-test',answers,usage:{input_tokens:1}})}}}}
}

test('native pool is exactly Luna Max research and Astra XHigh command/integration',async()=>{
  const native=listModels({provider:'openai'})
  assert.deepEqual(native.map(value=>[value.id,value.efforts]),[['gpt-5.6-luna',['max']],['gpt-6-astra',['xhigh']]])
  const plan=await planTask(input,{useJev:false,env:{HARNESS_ENGINEER_MODEL:'gpt-5.6-luna',HARNESS_ENGINEER_EFFORT:'low'}})
  assert.equal(plan.commander.model,'gpt-6-astra');assert.equal(plan.commander.effort,'xhigh');assert.equal(plan.commander.billingSource,'chatgpt_plan')
  assert.equal(plan.route.model,'gpt-6-astra');assert.equal(plan.route.effort,'xhigh');assert.equal(plan.routingDecision.handoff.scope,'commander')
  assert.equal(plan.review.required,true);assert.equal(plan.review.reviewer.count,1);assert.equal(plan.review.reviewer.fresh,true)
  const research=await planTask({task:'Find every caller of reconcileSwapFill'},{useJev:false,env:{}})
  assert.equal(research.route.model,'gpt-5.6-luna');assert.equal(research.route.effort,'max');assert.equal(research.review.required,false)
  assert.equal(research.delegation.policy.readOnly,true);assert.match(research.delegation.instruction,/Do not edit files, implement, perform final review, approve changes or commit/)
  assert.deepEqual(routingModels({HARNESS_ENABLE_PAID_EXECUTION:'true',XAI_API_KEY:'mock',DEEPSEEK_API_KEY:'mock',KIMI_API_KEY:'mock'},'scout').map(value=>`${value.provider}:${value.id}`),['openai:gpt-5.6-luna'])
  assert.equal(createDelegationRequest({role:'scout',packet:{task:'Find callers'}}).policy.readOnly,true)
})

test('Jev cannot disguise implementation as Luna research or waive final acceptance',async()=>{
  const {options}=await fixture({worker:choice('scout'),execution_lane:choice('native_host'),native_target:choice('openai:gpt-5.6-luna'),effort:choice('low'),review_required:{type:'noul',noul:0}})
  const plan=await planTask({...input,task:'Find the issue and fix the helper',taskKind:'research'},options)
  assert.equal(plan.route.role,'engineer');assert.equal(plan.route.model,'gpt-6-astra');assert.equal(plan.route.effort,'xhigh')
  assert.equal(plan.review.required,true);assert.equal(plan.advice.reviewRequired.probability,0)
  assert.equal(plan.routingDecision.selection.worker.jev.accepted,false)
})

test('quality-first Jev questions exclude Flash for ordinary work and retain capable external selections',async()=>{
  for(const model of ['xai:grok-4.6','deepseek:deepseek-v4-pro','kimi:kimi-k3']){
    const {options,calls}=await fixture({worker:choice('engineer'),execution_lane:choice('external_api'),external_target:choice(model),native_target:choice('openai:gpt-6-astra'),effort:choice('high')})
    const plan=await planTask(input,options)
    assert.equal(`${plan.route.provider}:${plan.route.model}`,model)
    assert.equal(calls.length,1);assert.equal(calls[0].questions.external_target.criteria['deepseek:deepseek-flash'],undefined)
    assert.match(calls[0].questions.external_target.instructions,/most capable suitable/)
    assert.match(calls[0].questions.external_target.instructions,/cost only as the final tie-breaker/)
    assert.doesNotMatch(JSON.stringify(calls[0].questions),/cheapest/)
    assert.match(plan.delegation.instruction,/complete candidate implementation patch/)
    assert.equal(plan.delegation.policy.mayCommit,false);assert.equal(plan.review.required,true)
  }
})

test('Flash requires an explicit bounded mechanical envelope even for authorized requests',async()=>{
  const {options,calls}=await fixture({worker:choice('engineer'),execution_lane:choice('external_api'),external_target:choice('deepseek:deepseek-flash'),effort:choice('high')})
  const ordinary=await planTask(input,options)
  assert.equal(ordinary.route.model,'deepseek-v4-pro')
  const mechanical=await planTask({...input,taskKind:'mechanical'},options)
  assert.equal(mechanical.route.model,'deepseek-flash');assert.ok(calls[1].questions.external_target.criteria['deepseek:deepseek-flash'])
  for(const patch of [{risk:'high'},{task:'Find callers and fix wallet settlement',risk:'low'},{rootCause:null},{evidence:[]},{files:['a.js','b.js']},{openQuestions:['Unknown caller invariant']}]){
    const plan=await planTask({...input,taskKind:'mechanical',...patch,requestedRoute:{provider:'deepseek',model:'deepseek-flash',effort:'high'},requestedRouteAuthorized:true},options)
    assert.notEqual(plan.route.model,'deepseek-flash');assert.equal(plan.routingDecision.selection.target.requested.accepted,false)
  }
})

test('workstreams get task-specific pools in one call; research remains read-only inside a build phase',async()=>{
  const answers={execution_lane:choice('native_host'),native_target:choice('openai:gpt-6-astra'),effort:choice('high'),
    workstream_0_execution_lane:choice('native_host'),workstream_0_native_target:choice('openai:gpt-5.6-luna'),workstream_0_effort:choice('low'),
    workstream_1_execution_lane:choice('external_api'),workstream_1_native_target:choice('openai:gpt-6-astra'),workstream_1_external_target:choice('kimi:kimi-k3'),workstream_1_effort:choice('high')}
  const {options,calls}=await fixture(answers)
  const plan=await routeTask({...input,workstreams:[{id:'research',task:'Trace callers and report findings',files:['src/callers.js']},{id:'code',...input}]},options)
  assert.equal(calls.length,1)
  assert.deepEqual(Object.keys(calls[0].questions.workstream_0_native_target.criteria),['openai:gpt-5.6-luna'])
  assert.deepEqual(Object.keys(calls[0].questions.workstream_1_native_target.criteria),['openai:gpt-6-astra'])
  assert.equal(calls[0].questions.workstream_1_external_target.criteria['deepseek:deepseek-flash'],undefined)
  const [research,code]=plan.routingDecision.parallel.assignments
  assert.equal(research.effective.model,'gpt-5.6-luna');assert.equal(research.effective.effort,'max');assert.equal(research.delegation.policy.readOnly,true)
  assert.equal(code.effective.model,'kimi-k3');assert.equal(code.delegation.policy.review.required,true)
  assert.equal(plan.review.independentReviewCount,1)
  assert.equal(plan.review.finalAuthority.model,'gpt-6-astra')
})

test('implementation workstreams require phase acceptance and their own commit gate inside research phases',async()=>{
  const plan=await planTask({task:'Investigate the two helper issues',workstreams:[
    {id:'code',task:'Fix the supplied helper',rootCause:'wrong bound',evidence:['complete helper excerpt'],files:['src/a.js']},
    {id:'research',task:'Trace the other caller and report findings',files:['src/b.js']}
  ]},{useJev:false,env:{}})
  assert.equal(plan.policy.taskKind,'research');assert.equal(plan.review.required,true);assert.equal(plan.policy.commitGate.required,true)
  const [code,research]=plan.routingDecision.parallel.assignments
  assert.equal(code.delegation.context.taskKind,'implementation');assert.equal(code.delegation.policy.commitGate.required,true);assert.equal(code.delegation.policy.review.required,true)
  assert.equal(research.delegation.context.taskKind,'research');assert.equal(research.delegation.policy.commitGate.required,false);assert.equal(research.delegation.policy.readOnly,true)
})

test('direct external execution cannot bypass Flash or final-review restrictions',async()=>{
  const {options}=await fixture();let invocations=0
  clearProviders();registerProvider('deepseek',{execute:async()=>{invocations++;throw new Error('must not call')}})
  for(const [role,model] of [['engineer','deepseek-flash'],['reviewer','deepseek-v4-pro']]){
    const result=await executeDelegation({delegation:{role,context:input},provider:'deepseek',model,effort:'high',...options})
    assert.equal(result.reason,'quality-capability-policy')
  }
  assert.equal(invocations,0)
})

test('Flash continuation permits the same source but blocks cumulative source expansion before invocation',async()=>{
  const run=async approvedEvidence=>{
    const {options}=await fixture();let invocations=0
    clearProviders();registerProvider('deepseek',{execute:async request=>{invocations++;return invocations===1
      ?normalizeResult({provider:'deepseek',model:request.model,role:request.role,usage:{inputTokens:2,outputTokens:1},metadata:{responseId:'flash-1',continuationRequired:true,toolCalls:[{name:'request_context',arguments:JSON.stringify({paths:['src/helper.js'],reason:'need bounded excerpt'})}]}})
      :normalizeResult({provider:'deepseek',model:request.model,role:request.role,usage:{inputTokens:2,outputTokens:1},metadata:{toolCalls:[{name:'report_result',arguments:JSON.stringify({status:'complete',findings:['done'],artifact:'patch',evidence:['approved'],tests:[],blockers:[]})}]}})}})
    const delegation={role:'engineer',context:{...input,risk:'normal',taskKind:'mechanical',openQuestions:[]},instruction:'bounded mechanical patch'}
    const first=await executeDelegation({delegation,provider:'deepseek',model:'deepseek-flash',effort:'high',env:options.env,store:options.store})
    assert.equal(first.executed,true);assert.equal(first.result.completion.reason,'bounded-context-requested')
    const resumed=await resumeDelegation({jobId:first.job.id,approvedEvidence,env:options.env,store:options.store})
    return{resumed,invocations}
  }
  const same=await run({files:['src/helper.js'],inspected:[{path:'src/helper.js',range:'1-20'}],evidence:['same-file excerpt']})
  assert.equal(same.resumed.executed,true);assert.equal(same.invocations,2)
  const expanded=await run({files:['src/b.js','src/c.js'],evidence:['additional sources']})
  assert.equal(expanded.resumed.executed,false);assert.equal(expanded.resumed.reason,'quality-capability-policy');assert.equal(expanded.invocations,1)
})

test('final review is exactly one native fresh read-only Astra XHigh and makes no Jev call',async()=>{
  const {options,calls}=await fixture({execution_lane:choice('external_api'),external_target:choice('kimi:kimi-k3')})
  const plan=await reviewRoute({...input,requestedRoute:{provider:'kimi',model:'kimi-k3',effort:'high'},requestedRouteAuthorized:true,reviewContext:{artifactDigest:'a'.repeat(64),commanderAgentId:'commander'}},options)
  assert.equal(calls.length,0);assert.equal(plan.route.model,'gpt-6-astra');assert.equal(plan.route.effort,'xhigh')
  assert.equal(plan.routingDecision.handoff.scope,'fresh-final-reviewer');assert.equal(plan.routingDecision.handoff.orchestration.maxAgents,1)
  assert.equal(plan.delegation.policy.readOnly,true);assert.match(plan.delegation.instruction,/Do not edit, apply patches or commit/)
  assert.equal(plan.packet.reviewContext.artifactDigest,'a'.repeat(64));assert.equal(plan.review.required,false)
})

test('commit is denied until exact artifact verification and fresh Astra acceptance are complete',async()=>{
  const {options}=await fixture(),artifactDigest='a'.repeat(64)
  const plan=await reviewRoute({...input,reviewContext:{artifactDigest,commanderAgentId:'commander'}},options)
  const commit={reviewDecisionId:plan.routingDecision.decisionId,artifactDigest,commander:{agentId:'commander',provider:'openai',model:'gpt-6-astra',effort:'xhigh'},review:{agentId:'reviewer',provider:'openai',model:'gpt-6-astra',effort:'xhigh',artifactDigest,fresh:true,readOnly:true,accepted:true,blockers:[]},verification:{artifactDigest,scopeVerified:true,checks:['tests','build','typecheck','lint'].map(name=>({name,status:'passed',evidence:`${name} passed on integrated artifact`}))}}
  assert.equal((await checkAction({action:'commit'},options)).allowed,false)
  const approved=await checkAction({action:'commit',commit},options)
  assert.equal(approved.allowed,true);assert.equal(approved.evidenceSource,'host-attested');assert.equal(approved.hostMustEnforce,true)
  const mutations=[
    value=>value.artifactDigest='b'.repeat(64),value=>value.review.artifactDigest='b'.repeat(64),value=>value.review.accepted=false,
    value=>value.review.blockers=['regression'],value=>value.review.agentId='commander',value=>value.review.fresh=false,
    value=>value.review.provider='kimi',value=>value.review.model='gpt-5.6-luna',value=>value.review.effort='high',value=>value.review.readOnly=false,
    value=>value.commander.model='gpt-5.6-sol',value=>value.commander.agentId='other',
    value=>value.verification.artifactDigest='b'.repeat(64),value=>value.verification.scopeVerified=false,
    value=>value.verification.checks.pop(),value=>value.verification.checks[0].status='failed',
    value=>{value.verification.checks[0].status='not_applicable';value.verification.checks[0].reason='skip tests'}
  ]
  for(const mutate of mutations){const changed=structuredClone(commit);mutate(changed);assert.equal((await checkAction({action:'commit',commit:changed,explicitlyAuthorized:true},options)).allowed,false)}
  const next=await reviewRoute({...input,reviewContext:{artifactDigest:'b'.repeat(64),commanderAgentId:'commander'}},options)
  assert.notEqual(next.routingDecision.decisionId,plan.routingDecision.decisionId)
  const worker=await routeTask(input,{...options,useJev:false})
  assert.equal((await checkAction({action:'commit',commit:{...commit,reviewDecisionId:worker.routingDecision.decisionId}},options)).allowed,false)
  assert.equal((await checkAction({action:'commit',commit},{...options,planCache:new PlanCache()})).allowed,false)
})
