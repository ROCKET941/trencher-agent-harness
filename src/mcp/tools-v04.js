import {planTask} from '../orchestrator.js'
import {executeDelegation,resumeDelegation,getJobStatus,getTaskUsage,cancelJob} from '../execution/executor.js'
import {getProviderStatus} from '../providers/status.js'
import {modelCatalogSummary} from '../providers/catalog.js'

const API_COMMANDER_TARGET={provider:'openai',model:'gpt-5.6-sol',effort:'xhigh',configured:true}
const complete=execution=>execution?.executed===true&&execution.result?.completion?.status==='complete'&&execution.result?.structured?.status==='complete'
const phaseKey=(key,phase)=>key?`${key}:${phase}`:undefined
function planningDelegation(plan){return{role:'reviewer',context:{...plan.packet,phase:'planning'},instruction:'Produce a complete, bounded implementation plan for the routed worker. Identify the exact work, evidence, verification, and blockers. Do not implement or authorize protected actions. Return report_result with status complete only when the plan is sufficient for the worker to proceed.'}}
function workerDelegation(plan,planning){return{...plan.delegation,context:{...plan.delegation.context,commanderPlan:planning.result.structured}}}
function reviewDelegation(plan,planning,execution){return{role:'reviewer',context:{...plan.packet,phase:'final-review',commanderPlan:planning.result.structured,workerResult:execution.result.structured},instruction:'Independently review the routed worker result against the task and commander plan. Verify evidence, tests, safety boundaries, and completeness. Do not authorize protected actions. Return report_result with status complete only when the result passes final review; otherwise return incomplete or blocked with precise blockers.'}}
const runPhase=(delegation,target,input,options,attemptClass,idempotencyKey)=>executeDelegation({delegation,...target,budget:input.budget,env:options.env||process.env,taskId:input.taskId,idempotencyKey,workspace:input.workspace,deadlineMs:input.deadlineMs,store:options.store,signal:options.signal,attemptClass})

export async function executeRoutedTask(input={},options={}){
  const env=options.env||process.env,commanderMode=input.commanderMode||'host'
  if(commanderMode==='api'&&!input.apiCommanderOptIn)return{plan:null,execution:null,reason:'api-commander-requires-explicit-opt-in'}
  if(commanderMode==='api'&&input.hostCommanderActive)return{plan:null,execution:null,reason:'duplicate-host-and-api-commander'}
  if(commanderMode==='api'&&env.HARNESS_ENABLE_API_COMMANDER!=='true')return{plan:null,execution:null,reason:'api-commander-owner-gate-disabled'}
  if(env.HARNESS_ENABLE_PAID_EXECUTION!=='true')return{plan:null,execution:null,reason:'paid-execution-owner-gate-disabled'}
  const plan=await planTask(input,options);if(!plan.delegation)return{plan,execution:null}
  const target=plan.routingDecision.effective
  if(!target.configured)return{plan,execution:null,target,reason:'provider-model-not-configured'}
  const planned={...plan,commander:{mode:commanderMode,apiCommander:commanderMode==='api'}}
  if(commanderMode==='host'){
    const execution=await runPhase(plan.delegation,target,input,{...options,env},'worker',input.idempotencyKey)
    return{plan:planned,target,execution}
  }
  const planning=await runPhase(planningDelegation(plan),API_COMMANDER_TARGET,input,{...options,env},'auxiliary',phaseKey(input.idempotencyKey,'planning'))
  if(!complete(planning))return{plan:planned,target,commanderTarget:API_COMMANDER_TARGET,planning,execution:null,review:null,reason:'api-planning-incomplete'}
  const execution=await runPhase(workerDelegation(plan,planning),target,input,{...options,env},'worker',phaseKey(input.idempotencyKey,'worker'))
  if(!complete(execution))return{plan:planned,target,commanderTarget:API_COMMANDER_TARGET,planning,execution,review:null,reason:'api-worker-incomplete'}
  const review=await runPhase(reviewDelegation(plan,planning,execution),API_COMMANDER_TARGET,input,{...options,env},'auxiliary',phaseKey(input.idempotencyKey,'review'))
  if(!complete(review))return{plan:planned,target,commanderTarget:API_COMMANDER_TARGET,planning,execution,review,reason:'api-review-incomplete'}
  return{plan:planned,target,commanderTarget:API_COMMANDER_TARGET,planning,execution,review}
}
export const jobStatus=(input={},options={})=>getJobStatus(input.jobId,options)
export const taskUsage=(input={},options={})=>getTaskUsage(input.taskId,options)
export const cancelExecution=(input={},options={})=>cancelJob(input.jobId,options)
export const resumeRoutedTask=(input={},options={})=>{
  const env=options.env||process.env
  if(env.HARNESS_ENABLE_PAID_EXECUTION!=='true')return{executed:false,reason:'paid-execution-owner-gate-disabled'}
  return resumeDelegation({...input,env,store:options.store,signal:options.signal})
}
export const providerStatus=(input={},options={})=>getProviderStatus(input.provider,{...options,refresh:Boolean(input.refresh)})
export const modelCatalog=()=>modelCatalogSummary()
