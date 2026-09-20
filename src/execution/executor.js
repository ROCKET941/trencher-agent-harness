import path from 'node:path'
import routing from '../../config/routing.json' with {type:'json'}
import { getProvider } from '../providers/registry-v12.js'
import { validateModel, estimateCostUsd } from '../providers/catalog.js'
import { resolveBudget, checkEstimatedInput } from '../budget/executionBudget.js'
import { AccountingStore } from './accountingStore.js'
import { taskIdentityFromContext, digestValue } from './taskIdentity.js'
import { normalizeApprovedEvidence, safeRelativePath } from './boundedEvidence.js'

const stores=new Map(), active=new Map()
export function taskIdentity(delegation,workspace=''){return taskIdentityFromContext(delegation.context,workspace)}
export function getAccountingStore(env=process.env){const file=env.HARNESS_STATE_FILE||path.join(process.cwd(),'.state','accounting.json');if(!stores.has(file))stores.set(file,new AccountingStore({file,env}));return stores.get(file)}

function validateTools(result){
  const allowed=new Set(routing.delegateTools),toolCalls=result.metadata?.toolCalls||[],denied=[]
  for(const call of toolCalls){
    if(!allowed.has(call.name)){denied.push(call.name);continue}
    if(call.name==='request_context'){
      let args
      try{args=typeof call.arguments==='string'?JSON.parse(call.arguments):call.arguments}catch{denied.push('request_context:invalid-json');continue}
      for(const value of args?.paths||[])if(!safeRelativePath(value))denied.push('request_context:unsafe-path')
    }
  }
  return{allowed:denied.length===0,denied}
}
function structuredOutput(result,incomplete){const call=(result.metadata?.toolCalls||[]).find(item=>item.name==='report_result');let value=null;try{value=call?(typeof call.arguments==='string'?JSON.parse(call.arguments):call.arguments):null}catch{}const valid=value&&['complete','incomplete','blocked'].includes(value.status)&&(value.artifact==null||typeof value.artifact==='string')&&['findings','evidence','tests','blockers'].every(key=>Array.isArray(value[key]));if(valid)return{status:incomplete?'incomplete':value.status,findings:value.findings,artifact:value.artifact??null,evidence:value.evidence,tests:value.tests,blockers:value.blockers,usage:result.usage};return{status:'incomplete',findings:[],artifact:result.output||null,evidence:[],tests:[],blockers:['Delegate did not return a valid report_result contract.'],usage:result.usage}}
function contextRequest(result){const call=(result.metadata?.toolCalls||[]).find(item=>item.name==='request_context');if(!call)return null;try{return typeof call.arguments==='string'?JSON.parse(call.arguments):call.arguments}catch{return null}}
function reportArtifact(result){const call=(result.metadata?.toolCalls||[]).find(item=>item.name==='report_result');try{return call?(typeof call.arguments==='string'?JSON.parse(call.arguments):call.arguments):null}catch{return null}}
function validatedTarget(provider,model,effort){let validated=validateModel({provider,model,effort});if(!validated.allowed&&!['openai','xai','deepseek','kimi'].includes(provider))validated={allowed:true,entry:{provider,id:model,inputPerMTok:0,outputPerMTok:0,efforts:[effort].filter(Boolean)},localAdapter:true};return validated}

async function dispatch({request,provider,model,effort,budget,ledger,resolvedTaskId,idempotencyKey,deadlineMs,signal,attemptClass,evidenceHash,parentJobId}){
  const adapter=getProvider(provider),payload=typeof adapter.prepare==='function'?adapter.prepare(request):request,preflight=checkEstimatedInput(payload,budget)
  if(!preflight.allowed)return{executed:false,reason:'estimated-input-too-large',preflight,taskId:resolvedTaskId}
  const validated=validatedTarget(provider,model,effort)
  if(!validated.allowed)return{executed:false,reason:validated.reason,validation:validated,preflight,taskId:resolvedTaskId}
  const reservedCostUsd=estimateCostUsd(validated.entry,budget.maxInputTokens,budget.maxOutputTokens)
  if(reservedCostUsd==null)return{executed:false,reason:'unknown-price',preflight,taskId:resolvedTaskId}
  const effectiveDeadlineMs=Number(deadlineMs)||Number(request.timeoutMs)||30000
  const deadlineAt=new Date(Date.now()+effectiveDeadlineMs+1000).toISOString()
  const reservationInput={taskId:resolvedTaskId,idempotencyKey,provider,model,effort,reservedCostUsd,deadlineAt,evidenceHash,attemptClass}
  const reservation=parentJobId?await ledger.reserveContinuation(parentJobId,{...reservationInput,maxContinuationIndex:Math.max(0,budget.maxDelegations-1)}):await ledger.reserve(reservationInput)
  if(!reservation.allowed)return{executed:false,reason:reservation.reason,reservation,preflight,taskId:resolvedTaskId}
  if(reservation.deduplicated)return{executed:false,reason:'idempotent-replay',job:reservation.job,preflight,taskId:resolvedTaskId}
  const controller=new AbortController(),forward=()=>controller.abort(signal?.reason)
  if(signal?.aborted)forward();else signal?.addEventListener?.('abort',forward,{once:true})
  let deadlineTimer
  deadlineTimer=setTimeout(()=>controller.abort(new Error('deadline-exceeded')),effectiveDeadlineMs)
  active.set(reservation.job.id,controller);request.signal=controller.signal
  try{
    const result=await adapter.execute(request),tools=validateTools(result)
    if(!tools.allowed){const uncertain=result.metadata?.usageComplete===false,job=await ledger.finalize(reservation.job.id,{status:'failed',usage:result.usage,actualCostUsd:uncertain?null:estimateCostUsd(validated.entry,result.usage.inputTokens,result.usage.outputTokens),error:'delegate-tool-policy',uncertainBilling:uncertain});return{executed:false,reason:'delegate-tool-policy',tools,job,preflight,taskId:resolvedTaskId}}
    if(result.metadata?.usageComplete===false){const job=await ledger.finalize(reservation.job.id,{status:'failed',usage:result.usage,error:'usage-unavailable',uncertainBilling:true});return{executed:false,reason:'uncertain-billing',result,job,preflight,taskId:resolvedTaskId}}
    const report=reportArtifact(result),invalidArtifact=report&&report.artifact!=null&&typeof report.artifact!=='string',outputTooLarge=Math.max(result.output.length,typeof report?.artifact==='string'?report.artifact.length:0)>routing.limits.maxPatchChars,continuationRequired=Boolean(result.metadata?.continuationRequired),hasReport=Boolean(report),reportedIncomplete=hasReport&&report.status!=='complete',incomplete=Boolean(result.metadata?.incomplete)||outputTooLarge||continuationRequired||!hasReport||invalidArtifact||reportedIncomplete
    const completionReason=outputTooLarge?'output-or-patch-too-large':(invalidArtifact?'invalid-report-result':(continuationRequired?'bounded-context-requested':(!hasReport?'missing-report-result':(reportedIncomplete?`worker-reported-${report.status}`:(result.metadata?.incomplete?'provider-output-limit':null)))))
    result.completion={status:incomplete?'incomplete':'complete',reason:completionReason};result.structured=structuredOutput(result,incomplete)
    const continuation=completionReason==='bounded-context-requested'?{reason:completionReason,request:contextRequest(result),execution:{role:request.role,task:request.task,context:request.context,instruction:request.instruction,provider,model,effort,budget,responseId:result.metadata?.responseId||null}}:null
    const actualCostUsd=estimateCostUsd(validated.entry,result.usage.inputTokens,result.usage.outputTokens)
    const job=await ledger.finalize(reservation.job.id,{status:incomplete?'incomplete':'completed',usage:result.usage,actualCostUsd,completionReason,continuation})
    return{executed:true,result,job,preflight,taskId:resolvedTaskId,state:{active:0,inputTokens:result.usage.inputTokens,outputTokens:result.usage.outputTokens,delegations:(reservation.job.continuationIndex||0)+1}}
  }catch(error){const uncertain=Boolean(error?.uncertainBilling);const job=await ledger.finalize(reservation.job.id,{status:controller.signal.aborted?'cancelled':'failed',actualCostUsd:uncertain?null:0,error:error?.code||'provider-error',uncertainBilling:uncertain});return{executed:false,reason:controller.signal.aborted?'cancelled':(error?.code||'provider-error'),error:{provider:error?.provider||provider,code:error?.code||'provider-error',status:error?.status||null,retryable:Boolean(error?.retryable),uncertainBilling:uncertain},job,preflight,taskId:resolvedTaskId}}
  finally{clearTimeout(deadlineTimer);signal?.removeEventListener?.('abort',forward);active.delete(reservation.job.id)}
}

export async function executeDelegation({delegation,provider,model,effort,budget:asked,env=process.env,idempotencyKey,workspace='',deadlineMs,store,signal,attemptClass='worker'}) {
  const budget=resolveBudget(asked,env),ledger=store||getAccountingStore(env),resolvedTaskId=taskIdentity(delegation,workspace)
  const request={role:delegation.role,task:delegation.context?.task||'',context:delegation.context||{},instruction:delegation.instruction||'',provider,model,effort,budget,timeoutMs:Math.min(Number(env.HARNESS_PROVIDER_TIMEOUT_MS)||30000,Number(deadlineMs)||Infinity)}
  const evidenceHash=digestValue({rootCause:delegation.context?.rootCause||null,evidence:delegation.context?.evidence||[],facts:delegation.context?.facts||[],inspected:delegation.context?.inspected||[]})
  return dispatch({request,provider,model,effort,budget,ledger,resolvedTaskId,idempotencyKey,deadlineMs,signal,attemptClass,evidenceHash})
}

export async function resumeDelegation({jobId,approvedEvidence,budget:asked,env=process.env,deadlineMs,store,signal}){
  const ledger=store||getAccountingStore(env),prior=await ledger.getJob(jobId)
  if(!prior)return{executed:false,reason:'job-not-found'}
  if(prior.status!=='incomplete'||prior.completionReason!=='bounded-context-requested'||!prior.continuation)return{executed:false,reason:'job-not-resumable',job:prior}
  const normalized=normalizeApprovedEvidence(approvedEvidence,prior.continuation.execution.task,prior.continuation.execution.context?.risk)
  if(!normalized.allowed)return{executed:false,reason:normalized.reason,validation:normalized,job:prior}
  const original=prior.continuation.execution.budget,usage=(await ledger.getUsage(prior.taskId)).task||{},requested=resolveBudget(asked,env)
  const remainingInput=Math.trunc(original.maxInputTokens-Number(usage.inputTokens||0)),remainingOutput=Math.trunc(original.maxOutputTokens-Number(usage.outputTokens||0))
  if(remainingInput<=0||remainingOutput<=0)return{executed:false,reason:'continuation-token-budget-exhausted',job:prior,taskId:prior.taskId}
  const budget={...original,maxInputTokens:Math.min(original.maxInputTokens,requested.maxInputTokens,remainingInput),maxEstimatedInputTokens:Math.min(original.maxEstimatedInputTokens,requested.maxEstimatedInputTokens,remainingInput),maxOutputTokens:Math.min(original.maxOutputTokens,requested.maxOutputTokens,remainingOutput),maxDelegations:Math.min(original.maxDelegations,requested.maxDelegations)}
  const execution=prior.continuation.execution,continuation={request:prior.continuation.request,approvedEvidence:normalized.evidence,truncation:normalized.truncation}
  const request={role:execution.role,task:execution.task,context:{...execution.context,approvedEvidence:normalized.evidence},instruction:execution.instruction,provider:execution.provider,model:execution.model,effort:execution.effort,budget,previousResponseId:execution.responseId,continuation,timeoutMs:Math.min(Number(env.HARNESS_PROVIDER_TIMEOUT_MS)||30000,Number(deadlineMs)||Infinity)}
  return dispatch({request,provider:execution.provider,model:execution.model,effort:execution.effort,budget,ledger,resolvedTaskId:prior.taskId,idempotencyKey:`continuation:${jobId}`,deadlineMs,signal,attemptClass:'auxiliary',evidenceHash:digestValue(normalized.evidence),parentJobId:jobId})
}

export async function getJobStatus(jobId,{env=process.env,store}={}){return(store||getAccountingStore(env)).getJob(jobId)}
export async function getTaskUsage(taskId,{env=process.env,store}={}){return(store||getAccountingStore(env)).getUsage(taskId)}
export async function cancelJob(jobId,{env=process.env,store}={}){const ledger=store||getAccountingStore(env),controller=active.get(jobId);if(controller)controller.abort(new Error('cancelled-by-host'));const result=await ledger.cancel(jobId);if(result.cancelled&&!controller)await ledger.finalize(jobId,{status:'cancelled',error:'cancelled-without-live-dispatch',uncertainBilling:true});return{...result,abortSignalled:Boolean(controller)}}
