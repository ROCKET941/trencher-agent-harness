import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import routing from '../../config/routing.json' with { type:'json' }

const blank=()=>({version:2,jobs:{},tasks:{},days:{},idempotency:{}})
const dayKey=(now=Date.now())=>new Date(now).toISOString().slice(0,10)
const positive=(value,fallback)=>Number.isFinite(Number(value))&&Number(value)>0?Number(value):fallback
const blankTask=()=>({starts:0,auxiliaryStarts:0,actualCostUsd:0,reservedCostUsd:0,inputTokens:0,outputTokens:0,uncertainBilling:false,lastEvidenceHash:null})

export class AccountingStore {
  #tail=Promise.resolve()
  constructor({file,env=process.env,now=()=>Date.now()}={}){this.file=file;this.env=env;this.now=now}
  async #load(){if(!this.file)return blank();try{return JSON.parse(await readFile(this.file,'utf8'))}catch(error){if(error.code==='ENOENT')return blank();throw error}}
  async #save(state){if(!this.file)return;await mkdir(dirname(this.file),{recursive:true});const temp=`${this.file}.${process.pid}.${randomUUID()}.tmp`;await writeFile(temp,JSON.stringify(state,null,2),{encoding:'utf8',mode:0o600});await rename(temp,this.file)}
  #locked(operation){const next=this.#tail.then(operation,operation);this.#tail=next.catch(()=>{});return next}
  #recoverExpired(state,now){let changed=false;for(const job of Object.values(state.jobs)){if(job.status!=='running'||!job.deadlineAt||Date.parse(job.deadlineAt)>now)continue;const task=state.tasks[job.taskId],daily=state.days[job.createdAt.slice(0,10)];job.status='uncertain';job.error='deadline-expired-without-reconciliation';job.finishedAt=new Date(now).toISOString();job.actualCostUsd=job.reservedCostUsd;task.reservedCostUsd=Math.max(0,task.reservedCostUsd-job.reservedCostUsd);task.actualCostUsd+=job.reservedCostUsd;task.uncertainBilling=true;daily.reservedCostUsd=Math.max(0,daily.reservedCostUsd-job.reservedCostUsd);daily.actualCostUsd+=job.reservedCostUsd;changed=true}return changed}
  #reserveState(state,input,limits,now,day,parentJob=null){
    const attemptClass=input.attemptClass==='auxiliary'?'auxiliary':'worker',idempotencyScope=input.idempotencyKey?`${input.taskId}:${input.idempotencyKey}`:null
    if(idempotencyScope&&state.idempotency[idempotencyScope])return{allowed:true,deduplicated:true,job:structuredClone(state.jobs[state.idempotency[idempotencyScope]])}
    const active=Object.values(state.jobs).filter(job=>job.status==='running').length
    if(active>=limits.maxParallel)return{allowed:false,reason:'concurrency-limit',active,limit:limits.maxParallel}
    const task=state.tasks[input.taskId]||blankTask();task.starts=Number(task.starts||0);task.auxiliaryStarts=Number(task.auxiliaryStarts||0);task.inputTokens=Number(task.inputTokens||0);task.outputTokens=Number(task.outputTokens||0)
    if(task.uncertainBilling)return{allowed:false,reason:'uncertain-billing',scope:'task'}
    if(attemptClass==='worker'&&task.starts>=limits.maxStartsPerTask)return{allowed:false,reason:'task-start-limit',starts:task.starts,limit:limits.maxStartsPerTask}
    if(attemptClass==='worker'&&task.starts>=1&&(!input.evidenceHash||input.evidenceHash===task.lastEvidenceHash))return{allowed:false,reason:task.starts===1?'second-attempt-requires-new-causal-evidence':'retry-requires-new-causal-evidence'}
    if(attemptClass==='worker'&&task.starts>=2&&!input.ownerAuthorizedRetry)return{allowed:false,reason:'third-attempt-requires-owner-authorization'}
    if(attemptClass==='worker'&&task.starts>=2&&!String(input.retryReason||'').trim())return{allowed:false,reason:'owner-authorized-retry-requires-reason'}
    const daily=state.days[day]||{actualCostUsd:0,reservedCostUsd:0},cost=Number(input.reservedCostUsd)
    if(!Number.isFinite(cost)||cost<0)return{allowed:false,reason:'unknown-price'}
    if(task.actualCostUsd+task.reservedCostUsd+cost>limits.taskCostUsd)return{allowed:false,reason:'task-cost-limit'}
    if(daily.actualCostUsd+daily.reservedCostUsd+cost>limits.dailyCostUsd)return{allowed:false,reason:'daily-cost-limit'}
    const job={id:randomUUID(),taskId:input.taskId,idempotencyKey:input.idempotencyKey||null,attemptClass,provider:input.provider,model:input.model,effort:input.effort,status:'running',createdAt:new Date(now).toISOString(),deadlineAt:input.deadlineAt||null,evidenceHash:input.evidenceHash||null,ownerAuthorizedRetry:Boolean(input.ownerAuthorizedRetry),retryReason:String(input.retryReason||'').trim().slice(0,500)||null,reservedCostUsd:cost,actualCostUsd:null,usage:null,error:null,parentJobId:parentJob?.id||null,continuationIndex:parentJob?Number(parentJob.continuationIndex||0)+1:0}
    state.jobs[job.id]=job
    if(attemptClass==='worker'){task.starts++;task.lastEvidenceHash=input.evidenceHash||task.lastEvidenceHash}else task.auxiliaryStarts++
    task.reservedCostUsd+=cost;state.tasks[input.taskId]=task;daily.reservedCostUsd+=cost;state.days[day]=daily
    if(parentJob)parentJob.continuedByJobId=job.id
    if(idempotencyScope)state.idempotency[idempotencyScope]=job.id
    return{allowed:true,deduplicated:false,job:structuredClone(job),limits}
  }
  limits(){return{maxParallel:Math.min(routing.limits.hardMaxParallel,Math.max(1,Math.trunc(positive(this.env.HARNESS_MAX_PARALLEL,routing.limits.maxParallel)))),hardMaxParallel:routing.limits.hardMaxParallel,maxStartsPerTask:Math.min(routing.limits.maxAttempts,Math.max(1,Math.trunc(positive(this.env.HARNESS_MAX_ATTEMPTS,routing.limits.maxStartsPerTask)))),taskCostUsd:positive(this.env.HARNESS_TASK_COST_USD,routing.limits.taskCostUsd),dailyCostUsd:positive(this.env.HARNESS_DAILY_COST_USD,routing.limits.dailyCostUsd)}}
  reserve(input){return this.#locked(async()=>{const state=await this.#load(),limits=this.limits(),now=this.now(),day=dayKey(now);if(this.#recoverExpired(state,now))await this.#save(state);const result=this.#reserveState(state,input,limits,now,day);if(result.allowed&&!result.deduplicated)await this.#save(state);return result})}
  reserveContinuation(parentJobId,input){return this.#locked(async()=>{
    const state=await this.#load(),limits=this.limits(),now=this.now(),day=dayKey(now);if(this.#recoverExpired(state,now))await this.#save(state)
    const parent=state.jobs[parentJobId]
    if(!parent)return{allowed:false,reason:'job-not-found'}
    if(parent.continuedByJobId)return{allowed:true,deduplicated:true,job:structuredClone(state.jobs[parent.continuedByJobId])}
    if(parent.status!=='incomplete'||parent.completionReason!=='bounded-context-requested'||!parent.continuation)return{allowed:false,reason:'job-not-resumable'}
    if(input.taskId!==parent.taskId)return{allowed:false,reason:'continuation-task-mismatch'}
    if(Number(parent.continuationIndex||0)>=Number(input.maxContinuationIndex||0))return{allowed:false,reason:'delegation-budget'}
    const result=this.#reserveState(state,{...input,attemptClass:'auxiliary',taskId:parent.taskId},limits,now,day,parent);if(result.allowed&&!result.deduplicated)await this.#save(state);return result
  })}
  finalize(jobId,{status='completed',usage=null,actualCostUsd=null,error=null,uncertainBilling=false,completionReason=null,continuation=null,costBasis=null,review=null}={}){return this.#locked(async()=>{
    const state=await this.#load(),job=state.jobs[jobId];if(!job)return null;if(job.status!=='running')return structuredClone(job)
    const day=job.createdAt.slice(0,10),task=state.tasks[job.taskId],daily=state.days[day];task.reservedCostUsd=Math.max(0,task.reservedCostUsd-job.reservedCostUsd);daily.reservedCostUsd=Math.max(0,daily.reservedCostUsd-job.reservedCostUsd)
    job.status=uncertainBilling?'uncertain':status;job.finishedAt=new Date(this.now()).toISOString();job.usage=usage;job.actualCostUsd=uncertainBilling?job.reservedCostUsd:(Number.isFinite(actualCostUsd)?actualCostUsd:null);job.error=error;job.completionReason=completionReason;job.continuation=continuation
    if(costBasis)job.costBasis=costBasis
    if(review)job.review=review
    if(uncertainBilling){task.uncertainBilling=true;task.actualCostUsd+=job.reservedCostUsd;daily.actualCostUsd+=job.reservedCostUsd}
    else{if(Number.isFinite(actualCostUsd)){task.actualCostUsd+=actualCostUsd;daily.actualCostUsd+=actualCostUsd}if(usage){task.inputTokens=Number(task.inputTokens||0)+Number(usage.inputTokens||0);task.outputTokens=Number(task.outputTokens||0)+Number(usage.outputTokens||0)}}
    state.jobs[jobId]=job;await this.#save(state);return structuredClone(job)
  })}
  getJob(jobId){return this.#locked(async()=>structuredClone((await this.#load()).jobs[jobId]||null))}
  getUsage(taskId){return this.#locked(async()=>{const state=await this.#load();return{taskId,task:structuredClone(state.tasks[taskId]||null),day:dayKey(this.now()),daily:structuredClone(state.days[dayKey(this.now())]||null),limits:this.limits()}})}
  cancel(jobId){return this.#locked(async()=>{const state=await this.#load(),job=state.jobs[jobId];if(!job)return{cancelled:false,reason:'job-not-found'};if(job.status!=='running')return{cancelled:false,reason:'job-not-running',job:structuredClone(job)};return{cancelled:true,job:structuredClone(job)}})}
}
