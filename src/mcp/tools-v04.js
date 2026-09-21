import {routeTask} from './tools.js'
import {planCache} from '../router/planCache.js'
import {executeDelegation,resumeDelegation,getJobStatus,getTaskUsage,cancelJob} from '../execution/executor.js'
import {getProviderStatus} from '../providers/status.js'
import {modelCatalogSummary} from '../providers/catalog.js'

const runPhase=(delegation,target,input,options,attemptClass,idempotencyKey)=>executeDelegation({delegation,...target,budget:input.budget,env:options.env||process.env,taskId:input.taskId,idempotencyKey,workspace:input.workspace,deadlineMs:input.deadlineMs,store:options.store,signal:options.signal,attemptClass,ownerAuthorizedRetry:Boolean(input.ownerAuthorizedRetry),retryReason:input.retryReason})

const ready = status => status.executionMode === 'native_host' || (status.configured && status.reachable !== false && status.eligible?.length > 0)

export async function providerReadiness(input={},options={}){
  const env=options.env||process.env,refresh=Boolean(input.refresh)
  const statuses=await Promise.all(['openai','xai','deepseek','kimi'].map(provider=>getProviderStatus(provider,{...options,env,refresh})))
  return{checkedAt:new Date().toISOString(),refresh,statuses:Object.fromEntries(statuses.map(status=>[status.provider,{...status,ready:ready(status)}]))}
}

export async function executeRoutedTask(input={},options={}){
  const env=options.env||process.env,commanderMode=input.commanderMode||'host'
  if(commanderMode==='api')return{plan:null,execution:null,reason:'api-commander-disabled-native-host-policy'}
  let plan, executionInput=input
  if(input.decisionId){
    // Only operational ceilings are accepted. Authority, task, evidence and target
    // come from the stored plan, never from an echoed or caller-edited response.
    const allowed=new Set(['decisionId','budget','deadlineMs','commanderMode'])
    const forbidden=Object.keys(input).filter(key=>!allowed.has(key)&&!(key==='task'&&input.task===''))
    if(forbidden.length)return{plan:null,execution:null,reason:'pinned-decision-overrides-not-allowed',fields:forbidden}
    plan=(options.planCache||planCache).get(input.decisionId)
    if(!plan)return{plan:null,execution:null,reason:'routing-decision-expired-or-unknown',decisionId:input.decisionId}
    executionInput={...plan.routingDecision.executionContext,budget:input.budget,deadlineMs:input.deadlineMs,idempotencyKey:input.decisionId}
  }else plan=await routeTask(input,options)
  if(!plan.delegation)return{plan,execution:null}
  const target=plan.routingDecision.effective
  const planned={...plan,commander:{mode:'host',apiCommander:false}}
  if(target.executionMode==='external_api'&&env.HARNESS_ENABLE_PAID_EXECUTION!=='true')return{plan:planned,target,execution:null,reason:'paid-execution-owner-gate-disabled'}
  const readiness=await getProviderStatus(target.provider,{...options,env,refresh:false})
  if(!ready(readiness))return{plan:planned,execution:null,target,readiness,reason:'provider-not-ready'}
  if(target.executionMode==='native_host')return{plan:planned,target,readiness:{...readiness,ready:true},execution:null,handoff:{...plan.routingDecision.handoff,delegation:plan.delegation},reason:'native-host-agent-required'}
  const execution=await runPhase(plan.delegation,target,executionInput,{...options,env},'worker',executionInput.idempotencyKey)
  return{plan:planned,target,readiness:{...readiness,ready:true},execution}
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
