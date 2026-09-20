import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {AccountingStore} from '../src/execution/accountingStore.js'
import {executeDelegation,cancelJob} from '../src/execution/executor.js'
import {registerProvider,clearProviders} from '../src/providers/registry-v12.js'
import {normalizeResult,ProviderError} from '../src/providers/base.js'

const tempStore=async(env={})=>{const dir=await mkdtemp(path.join(os.tmpdir(),'harness-ledger-'));return new AccountingStore({file:path.join(dir,'ledger.json'),env})}
const reservation={taskId:'task-a',provider:'openai',model:'gpt-5.6-luna',effort:'low',reservedCostUsd:.1}

test('atomic reservation enforces a real concurrent semaphore across job ids',async()=>{
  const store=await tempStore({HARNESS_MAX_PARALLEL:'1'}),results=await Promise.all([store.reserve({...reservation,idempotencyKey:'a'}),store.reserve({...reservation,taskId:'task-b',idempotencyKey:'b'})])
  assert.equal(results.filter(result=>result.allowed&&!result.deduplicated).length,1);assert.equal(results.find(result=>!result.allowed).reason,'concurrency-limit')
})

test('ledger persists starts and idempotency across store instances',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'harness-persist-')),file=path.join(dir,'ledger.json'),first=new AccountingStore({file,env:{HARNESS_MAX_PARALLEL:'2'}})
  const a=await first.reserve({...reservation,idempotencyKey:'same'});await first.finalize(a.job.id,{actualCostUsd:.01,usage:{inputTokens:1,outputTokens:1}})
  const second=new AccountingStore({file,env:{HARNESS_MAX_PARALLEL:'2'}}),again=await second.reserve({...reservation,idempotencyKey:'same'})
  assert.equal(again.deduplicated,true);assert.equal(again.job.id,a.job.id);assert.equal((await second.getUsage('task-a')).task.starts,1)
  assert.doesNotMatch(await readFile(file,'utf8'),/API_KEY|Bearer/)
})

test('idempotency keys are scoped to server-derived task identity',async()=>{
  const store=await tempStore({HARNESS_MAX_PARALLEL:'2'}),first=await store.reserve({...reservation,idempotencyKey:'same'});await store.finalize(first.job.id,{actualCostUsd:0})
  const other=await store.reserve({...reservation,taskId:'task-b',idempotencyKey:'same'})
  assert.equal(other.allowed,true);assert.equal(other.deduplicated,false);assert.notEqual(other.job.id,first.job.id)
})

test('auxiliary calls reserve cost and concurrency without consuming worker attempts',async()=>{
  const store=await tempStore({HARNESS_MAX_PARALLEL:'2'}),planning=await store.reserve({...reservation,attemptClass:'auxiliary'});await store.finalize(planning.job.id,{actualCostUsd:.01,usage:{inputTokens:1,outputTokens:1}})
  const first=await store.reserve({...reservation,evidenceHash:'a'});await store.finalize(first.job.id,{status:'failed',actualCostUsd:.01})
  const review=await store.reserve({...reservation,attemptClass:'auxiliary'});await store.finalize(review.job.id,{actualCostUsd:.01})
  const second=await store.reserve({...reservation,evidenceHash:'b'})
  const usage=await store.getUsage('task-a')
  assert.equal(second.allowed,true);assert.equal(usage.task.starts,2);assert.equal(usage.task.auxiliaryStarts,2);assert.equal(usage.task.actualCostUsd,.03)
})

test('third worker start requires owner authorization and new causal evidence',async()=>{
  const store=await tempStore({HARNESS_MAX_PARALLEL:'3'}),a=await store.reserve({...reservation,evidenceHash:'first'});await store.finalize(a.job.id,{status:'failed',actualCostUsd:0})
  const withoutEvidence=await store.reserve({...reservation,provider:'xai',model:'grok-4.6',evidenceHash:'first'});assert.equal(withoutEvidence.reason,'second-attempt-requires-new-causal-evidence')
  const b=await store.reserve({...reservation,provider:'xai',model:'grok-4.6',evidenceHash:'new-cause'});await store.finalize(b.job.id,{status:'failed',actualCostUsd:0})
  const withoutOwner=await store.reserve({...reservation,provider:'deepseek',model:'deepseek-v4-pro',evidenceHash:'third'});assert.equal(withoutOwner.reason,'third-attempt-requires-owner-authorization')
  const c=await store.reserve({...reservation,provider:'deepseek',model:'deepseek-v4-pro',evidenceHash:'third',ownerAuthorizedRetry:true,retryReason:'new trace isolates the branch'});assert.equal(c.allowed,true);assert.equal(c.job.ownerAuthorizedRetry,true);await store.finalize(c.job.id,{status:'failed',actualCostUsd:0})
  const fourth=await store.reserve({...reservation,evidenceHash:'fourth',ownerAuthorizedRetry:true,retryReason:'another retry'});assert.equal(fourth.allowed,false);assert.equal(fourth.reason,'task-start-limit')
})

test('uncertain billing releases concurrency but fails closed for the task',async()=>{
  const store=await tempStore(),a=await store.reserve(reservation);await store.finalize(a.job.id,{status:'failed',uncertainBilling:true,error:'network-error'});const next=await store.reserve(reservation),usage=await store.getUsage('task-a');assert.equal(next.allowed,false);assert.equal(next.reason,'uncertain-billing');assert.equal(usage.task.actualCostUsd,.1);assert.equal(usage.daily.actualCostUsd,.1);assert.equal(usage.daily.reservedCostUsd,0)
})

test('expired persisted reservations recover concurrency and charge worst-case reserve',async()=>{
  let now=Date.parse('2026-09-20T00:00:00Z');const dir=await mkdtemp(path.join(os.tmpdir(),'harness-deadline-')),file=path.join(dir,'ledger.json'),first=new AccountingStore({file,now:()=>now}),job=await first.reserve({...reservation,reservedCostUsd:.4,deadlineAt:new Date(now+10).toISOString()});now+=20;const restarted=new AccountingStore({file,now:()=>now}),next=await restarted.reserve({...reservation,taskId:'other'}),usage=await restarted.getUsage('task-a');assert.equal(next.allowed,true);assert.equal((await restarted.getJob(job.job.id)).status,'uncertain');assert.equal(usage.task.uncertainBilling,true);assert.equal(usage.task.actualCostUsd,.4);assert.equal(usage.daily.actualCostUsd,.4);assert.equal(usage.daily.reservedCostUsd,.1)
})

test('cost reservations enforce task and day limits before dispatch',async()=>{
  const store=await tempStore({HARNESS_MAX_PARALLEL:'3',HARNESS_TASK_COST_USD:'.15',HARNESS_DAILY_COST_USD:'.25'}),first=await store.reserve({...reservation,reservedCostUsd:.1,evidenceHash:'a'});await store.finalize(first.job.id,{actualCostUsd:.1});const taskBlocked=await store.reserve({...reservation,reservedCostUsd:.1,evidenceHash:'b'});const other=await store.reserve({...reservation,taskId:'other',reservedCostUsd:.14});const dayBlocked=await store.reserve({...reservation,taskId:'third',reservedCostUsd:.02});assert.equal(taskBlocked.reason,'task-cost-limit');assert.equal(other.allowed,true);assert.equal(dayBlocked.reason,'daily-cost-limit')
})

test('executor blocks untrusted tool calls and reconciles actual usage',async()=>{
  clearProviders();registerProvider('mock-local',{execute:async query=>normalizeResult({provider:'mock-local',model:query.model,role:query.role,output:'x',usage:{inputTokens:2,outputTokens:1},metadata:{toolCalls:[{name:'shell'}]}})})
  const result=await executeDelegation({delegation:{role:'engineer',context:{task:'bounded'},instruction:'work'},provider:'mock-local',model:'local',store:await tempStore()})
  assert.equal(result.executed,false);assert.equal(result.reason,'delegate-tool-policy');assert.equal(result.job.usage.inputTokens,2)
})

test('bounded continuation rejects traversal paths',async()=>{
  clearProviders();registerProvider('mock-path',{execute:async query=>normalizeResult({provider:'mock-path',model:query.model,role:query.role,usage:{},metadata:{toolCalls:[{name:'request_context',arguments:JSON.stringify({paths:['../../.env'],reason:'need it'})}]}})})
  const result=await executeDelegation({delegation:{role:'engineer',context:{task:'bounded'},instruction:'work'},provider:'mock-path',model:'local',store:await tempStore()})
  assert.equal(result.reason,'delegate-tool-policy');assert.deepEqual(result.tools.denied,['request_context:unsafe-path'])
})

test('bounded context requests are surfaced as incomplete instead of complete',async()=>{
  clearProviders();registerProvider('mock-context',{execute:async query=>normalizeResult({provider:'mock-context',model:query.model,role:query.role,usage:{inputTokens:2,outputTokens:1},metadata:{toolCalls:[{name:'request_context',arguments:JSON.stringify({paths:['src/a.js'],reason:'need direct caller'})}],continuationRequired:true}})})
  const result=await executeDelegation({delegation:{role:'engineer',context:{task:'bounded'},instruction:'work'},provider:'mock-context',model:'local',store:await tempStore()})
  assert.equal(result.executed,true);assert.equal(result.result.completion.status,'incomplete');assert.equal(result.result.completion.reason,'bounded-context-requested');assert.equal(result.job.status,'incomplete')
})

test('missing provider usage fails closed as uncertain billing',async()=>{
  clearProviders();registerProvider('mock-usage-missing',{execute:async query=>normalizeResult({provider:'mock-usage-missing',model:query.model,role:query.role,output:'done'})})
  const result=await executeDelegation({delegation:{role:'engineer',context:{task:'usage missing'},instruction:'work'},provider:'mock-usage-missing',model:'local',store:await tempStore()})
  assert.equal(result.executed,false);assert.equal(result.reason,'uncertain-billing');assert.equal(result.job.status,'uncertain')
})

test('oversized patch output is retained but never reported complete',async()=>{
  clearProviders();registerProvider('mock-large',{execute:async query=>normalizeResult({provider:'mock-large',model:query.model,role:query.role,output:'x'.repeat(80001),usage:{inputTokens:1,outputTokens:2}})})
  const result=await executeDelegation({delegation:{role:'engineer',context:{task:'large'},instruction:'work'},provider:'mock-large',model:'local',store:await tempStore()})
  assert.equal(result.executed,true);assert.equal(result.result.output.length,80001);assert.equal(result.result.completion.status,'incomplete');assert.equal(result.result.structured.status,'incomplete');assert.equal(result.job.status,'incomplete')
})

test('oversized report_result artifact is never reported complete',async()=>{
  clearProviders();registerProvider('mock-artifact',{execute:async query=>normalizeResult({provider:'mock-artifact',model:query.model,role:query.role,usage:{inputTokens:1,outputTokens:2},metadata:{toolCalls:[{name:'report_result',arguments:JSON.stringify({status:'complete',findings:[],artifact:'x'.repeat(80001),evidence:[],tests:[],blockers:[]})}]}})})
  const result=await executeDelegation({delegation:{role:'engineer',context:{task:'large structured artifact'},instruction:'work'},provider:'mock-artifact',model:'local',store:await tempStore()})
  assert.equal(result.executed,true);assert.equal(result.result.completion.status,'incomplete');assert.equal(result.result.completion.reason,'output-or-patch-too-large');assert.equal(result.job.status,'incomplete')
})

test('non-string report_result artifact is invalid and incomplete',async()=>{
  clearProviders();registerProvider('mock-invalid-artifact',{execute:async query=>normalizeResult({provider:'mock-invalid-artifact',model:query.model,role:query.role,usage:{inputTokens:1,outputTokens:1},metadata:{toolCalls:[{name:'report_result',arguments:JSON.stringify({status:'complete',findings:[],artifact:{patch:'x'},evidence:[],tests:[],blockers:[]})}]}})})
  const result=await executeDelegation({delegation:{role:'engineer',context:{task:'invalid artifact'},instruction:'work'},provider:'mock-invalid-artifact',model:'local',store:await tempStore()})
  assert.equal(result.result.completion.status,'incomplete');assert.equal(result.result.completion.reason,'invalid-report-result');assert.equal(result.result.structured.status,'incomplete')
})

test('worker-reported incomplete or blocked status cannot be persisted complete',async()=>{
  for(const status of ['incomplete','blocked']){clearProviders();registerProvider(`mock-${status}`,{execute:async query=>normalizeResult({provider:`mock-${status}`,model:query.model,role:query.role,usage:{inputTokens:1,outputTokens:1},metadata:{toolCalls:[{name:'report_result',arguments:JSON.stringify({status,findings:[],artifact:null,evidence:[],tests:[],blockers:['not done']})}]}})});const result=await executeDelegation({delegation:{role:'engineer',context:{task:`worker says ${status}`},instruction:'work'},provider:`mock-${status}`,model:'local',store:await tempStore()});assert.equal(result.result.completion.status,'incomplete');assert.equal(result.result.completion.reason,`worker-reported-${status}`);assert.equal(result.job.status,'incomplete')}
})

test('cancellation signals the provider and leaves uncertain billing blocked',async()=>{
  clearProviders();registerProvider('mock-cancel',{execute:query=>new Promise((_resolve,reject)=>query.signal.addEventListener('abort',()=>reject(new ProviderError('mock-cancel','cancelled',{uncertainBilling:true})),{once:true}))})
  const store=await tempStore(),pending=executeDelegation({delegation:{role:'engineer',context:{task:'wait'},instruction:'work'},provider:'mock-cancel',model:'local',taskId:'cancel-task',store})
  let jobs;for(let i=0;i<20;i++){await new Promise(resolve=>setTimeout(resolve,5));const usage=await store.getUsage('cancel-task');if(usage.task){jobs=usage;break}}
  const state=JSON.parse(await readFile(store.file,'utf8')),jobId=Object.keys(state.jobs)[0],cancelled=await cancelJob(jobId,{store}),result=await pending
  assert.equal(cancelled.abortSignalled,true);assert.equal(result.reason,'cancelled');assert.equal(result.job.status,'uncertain')
})

test('caller task ids cannot reset server-owned attempt accounting',async()=>{
  clearProviders();registerProvider('mock-task-id',{execute:async query=>normalizeResult({provider:'mock-task-id',model:query.model,role:query.role,usage:{inputTokens:1,outputTokens:1},metadata:{toolCalls:[{name:'report_result',arguments:JSON.stringify({status:'complete',findings:[],artifact:null,evidence:[],tests:[],blockers:[]})}]}})})
  const store=await tempStore({HARNESS_MAX_PARALLEL:'2'}),delegation={role:'engineer',context:{task:'same logical task'},instruction:'work'}
  const first=await executeDelegation({delegation,provider:'mock-task-id',model:'local',taskId:'caller-a',store})
  const second=await executeDelegation({delegation,provider:'mock-task-id',model:'local',taskId:'caller-b',store})
  assert.equal(first.executed,true);assert.equal(second.executed,false);assert.equal(second.reason,'second-attempt-requires-new-causal-evidence');assert.equal(first.taskId,second.taskId)
})

test('workspace and root-cause changes cannot reset server task identity',async()=>{
  clearProviders();registerProvider('mock-identity',{execute:async query=>normalizeResult({provider:'mock-identity',model:query.model,role:query.role,usage:{inputTokens:1,outputTokens:1},metadata:{toolCalls:[{name:'report_result',arguments:JSON.stringify({status:'complete',findings:[],artifact:null,evidence:[],tests:[],blockers:[]})}]}})})
  const store=await tempStore({HARNESS_MAX_PARALLEL:'2'}),base={role:'engineer',context:{task:'same immutable task',rootCause:'first'},instruction:'work'}
  const first=await executeDelegation({delegation:base,provider:'mock-identity',model:'local',workspace:'repo-a',store})
  const second=await executeDelegation({delegation:{...base,context:{...base.context,rootCause:'changed'}},provider:'mock-identity',model:'local',workspace:'repo-b',store})
  const third=await executeDelegation({delegation:{...base,context:{...base.context,rootCause:'changed again'}},provider:'mock-identity',model:'local',workspace:'repo-c',store})
  assert.equal(first.taskId,second.taskId);assert.equal(second.taskId,third.taskId);assert.equal(second.executed,true);assert.equal(third.executed,false);assert.equal(third.reason,'third-attempt-requires-owner-authorization')
})
