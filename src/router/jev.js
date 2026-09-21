import { createHash } from 'node:crypto'
import { listModels, eligibleForRole, resolveProviderKey, REGISTRY_VERSION } from '../providers/catalog.js'
import routing from '../../config/routing.json' with {type:'json'}
import { getAccountingStore } from '../execution/executor.js'
import { taskIdentityFromContext, digestValue } from '../execution/taskIdentity.js'
import { reconcileJevUsage } from '../execution/jevAccounting.js'
import { allowsFlash, taskKind } from '../policy/quality.js'
const BASE = 'https://api.typesafe.ai', RETRYABLE = new Set([429, 529]), cache=new Map(), MAX_RETRY_DELAY_MS=2000
const CONTEXT_PROFILES = new Set(['tight', 'normal', 'expanded'])
const RETRIEVAL_MODES = new Set(['exact', 'adjacent', 'exploratory'])
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const number = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback
export const jevConfigured = (env = process.env) => Boolean(env.TYPESAFE_API_KEY)
export function jevAvailability(env=process.env){
  if(!jevConfigured(env))return{available:false,reason:'jev-not-configured'}
  if(env.HARNESS_ENABLE_PAID_EXECUTION!=='true')return{available:false,reason:'jev-paid-execution-owner-gate-disabled'}
  const callCostUsd=Number(env.HARNESS_JEV_CALL_COST_USD)
  if(!Number.isFinite(callCostUsd)||callCostUsd<=0)return{available:false,reason:'jev-call-cost-bound-missing-or-invalid'}
  return{available:true,callCostUsd}
}
export const normalizeChoice = answer => answer?.type === 'choice'
  ? { choice: answer.choice, probabilities: answer.probabilities || {}, confidence: typeof answer.confidence === 'number' && Number.isFinite(answer.confidence) ? answer.confidence : 0 } : null
export const normalizeNoul = answer => answer?.type === 'noul' ? { probability: number(answer.noul, 0) } : null
export const normalizeContextProfile = answer => { const value = normalizeChoice(answer); return value && CONTEXT_PROFILES.has(value.choice) ? value : null }
export const normalizeRetrievalMode = answer => { const value = normalizeChoice(answer); return value && RETRIEVAL_MODES.has(value.choice) ? value : null }
export const normalizeExecutionLane = answer => { const value = normalizeChoice(answer); return value && ['native_host', 'external_api'].includes(value.choice) ? value : null }
export function routingModels(env = process.env, role = 'scout', context = {}) {
  return listModels().filter(model => eligibleForRole(role, model) && (model.id!=='deepseek-flash'||allowsFlash(context)) && (model.executionMode === 'native_host' || (env.HARNESS_ENABLE_PAID_EXECUTION === 'true' && Boolean(resolveProviderKey(model.provider, env).key))))
}
const laneCriteria = externalCriteria => ({ native_host:'Native ChatGPT plan worker with host workspace tools.', ...(Object.keys(externalCriteria).length ? { external_api:'Configured paid API worker for bounded supplied-content work.' } : {}) })
const qualityInstructions='Choose for expected correctness, task fit, evidence sufficiency and risk first; use relevant measured performance when available, then latency, with cost only as the final tie-breaker. Never invent benchmark history. Do not choose a weaker worker merely to reduce cost.'
const laneInstructions = subject => `Choose the appropriate execution environment for ${subject}, independently of model and effort. Native Luna Max only researches, reads and reports; Astra XHigh owns implementation, integration, tests and final acceptance. External API workers receive ONLY that workstream's supplied bounded evidence, can produce a complete candidate patch for Astra to apply and test, and cannot read files or execute tools; file paths alone are not source content. Prefer external_api for suitable bounded coding with sufficient evidence. Prefer native_host when direct workspace access or high-risk integration is essential. Do not force provider diversity. ${qualityInstructions}`
const criteriaFor=(models,mode)=>Object.fromEntries(models.filter(model=>model.executionMode===mode).map(model=>[`${model.provider}:${model.id}`,`${model.id}; capable roles: ${['scout','engineer','deep_debugger','reviewer','exceptional'].filter(role=>eligibleForRole(role,model)).join(', ')}; ${mode==='native_host'?'ChatGPT plan usage':`API USD/M input ${model.inputPerMTok}, output ${model.outputPerMTok}`}`]))
function workstreamQuestions(workstreams, env) {
  return Object.fromEntries(workstreams.flatMap((workstream, index) => {
    const role=workstream.routingRole||(workstream.risk==='high'&&!workstream.rootCause?'deep_debugger':workstream.taskKind==='research'?'scout':'engineer')
    const models=routingModels(env,role,workstream),nativeCriteria=criteriaFor(models,'native_host'),externalCriteria=criteriaFor(models,'external_api')
    const prefix=`workstream_${index}`
    return [
      [`${prefix}_execution_lane`,{type:'choice',instructions:laneInstructions(`state.workstreams[${index}]`),criteria:laneCriteria(externalCriteria)}],
      [`${prefix}_native_target`,{type:'choice',instructions:`Independently, IF a native worker is used for state.workstreams[${index}], follow the fixed Luna Max research / Astra XHigh implementation and acceptance contract. Do not depend on another answer.`,criteria:nativeCriteria}],
      ...(Object.keys(externalCriteria).length?[[`${prefix}_external_target`,{type:'choice',instructions:`Independently, IF an external worker is used for state.workstreams[${index}], select the most capable suitable candidate. ${qualityInstructions} Do not depend on another answer.`,criteria:externalCriteria}]]:[]),
      [`${prefix}_effort`,{type:'choice',instructions:`Independently estimate the smallest sufficient reasoning depth for state.workstreams[${index}]. Do not condition on another answer; code maps this level to a supported effort.`,criteria:{low:'Simple localized analysis or mechanical change.',medium:'Ordinary bounded engineering or review.',high:'Difficult causal analysis or consequential correctness.',xhigh:'Very difficult cross-cutting reasoning.',max:'Exceptional reasoning depth is necessary.'}}]
    ]
  }))
}
function delay(response, attempt) { const seconds = Number(response.headers?.get?.('retry-after')); return Math.min(MAX_RETRY_DELAY_MS,Number.isFinite(seconds)&&seconds>=0?seconds*1000:250*(2**attempt)) }

export async function askJev({ state, questions }, options = {}) {
  const env = options.env || process.env
  const availability=jevAvailability(env)
  if(!availability.available)return availability
  const ledger=options.store||getAccountingStore(env),taskContext=options.taskContext||{task:state?.task||''}
  const retries=Number(options.maxRetries??2),taskId=taskIdentityFromContext(taskContext),deadlineAt=new Date(Date.now()+number(env.TYPESAFE_TIMEOUT_MS,5000)*(retries+1)+MAX_RETRY_DELAY_MS*retries+1000).toISOString()
  const reservation=await ledger.reserve({taskId,provider:'typesafe',model:env.TYPESAFE_MODEL||'jev-latest',effort:null,reservedCostUsd:availability.callCostUsd,deadlineAt,evidenceHash:digestValue({state,questions}),attemptClass:'auxiliary'})
  if(!reservation.allowed)return{available:false,reason:`jev-accounting-${reservation.reason}`,taskId,reservation}
  const fetchImpl = options.fetchImpl || globalThis.fetch, timeout = number(env.TYPESAFE_TIMEOUT_MS, 5000), maxRetries = options.maxRetries ?? 2
  let priorUncertainBilling = false
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout)
    try {
      const response = await fetchImpl(`${BASE}/v1/systemone`, { method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${env.TYPESAFE_API_KEY}` },
        body: JSON.stringify({ model: env.TYPESAFE_MODEL || 'jev-latest', state, questions }) })
      if (RETRYABLE.has(response.status) && attempt < maxRetries) { clearTimeout(timer); await sleep(delay(response, attempt)); continue }
      if (!response.ok) {const job=await ledger.finalize(reservation.job.id,{status:'failed',actualCostUsd:availability.callCostUsd,error:`jev-http-${response.status}`});return { available: false, reason: `jev-http-${response.status}`, retries: attempt,job,taskId }}
      let raw
      try{raw=await response.json()}catch{const job=await ledger.finalize(reservation.job.id,{status:'failed',actualCostUsd:availability.callCostUsd,error:'jev-invalid-response'});return{available:false,reason:'jev-invalid-response',retries:attempt,job,taskId}}
      const accounting=reconcileJevUsage(raw.usage,availability.callCostUsd,{priorUncertainBilling,inputUsdPerMillion:env.HARNESS_JEV_INPUT_USD_PER_MILLION})
      const job=await ledger.finalize(reservation.job.id,{status:'completed',...accounting})
      return { available: true, reason: 'jev', model: raw.model, answers: raw.answers || {}, usage: raw.usage || {}, retries: attempt,job,taskId }
    } catch (error) {
      if (attempt < maxRetries && (error?.name === 'AbortError' || error instanceof TypeError)) { priorUncertainBilling = true; clearTimeout(timer); await sleep(250 * (2 ** attempt)); continue }
      const reason=error?.name === 'AbortError' ? 'jev-timeout' : 'jev-network-error',job=await ledger.finalize(reservation.job.id,{status:'failed',error:reason,uncertainBilling:true})
      return { available: false, reason, retries: attempt,job,taskId }
    } finally { clearTimeout(timer) }
  }
}

export async function askRoutingJev(packet, options = {}) {
  const availability=jevAvailability(options.env||process.env)
  if(!availability.available)return availability
  const kind=options.taskKind||taskKind(packet)
  const roleFloor=options.roleFloor||(kind==='research'?'scout':'engineer')
  const availableModels=routingModels(options.env||process.env,roleFloor,{...packet,taskKind:kind})
  const eligibleModels=availableModels.filter(model=>!options.eligibleModels||options.eligibleModels.some(candidate=>candidate.provider===model.provider&&candidate.id===model.id)),eligible=eligibleModels.map(model=>`${model.provider}:${model.id}`),targetExecutionModes=Object.fromEntries(eligibleModels.map(model=>[`${model.provider}:${model.id}`,model.executionMode])),targetEfforts=Object.fromEntries(eligibleModels.map(model=>[`${model.provider}:${model.id}`,model.efforts]))
  const nativeCriteria=criteriaFor(eligibleModels,'native_host'),externalCriteria=criteriaFor(eligibleModels,'external_api')
  const workstreams=Array.isArray(options.workstreams)?options.workstreams.slice(0,3):[]
  const state={task:packet.task,task_kind:kind,risk:packet.risk,root_cause_known:Boolean(packet.rootCause),root_cause:packet.rootCause,evidence:packet.evidence,files:packet.files,tests:packet.tests,docs:packet.docs,open_questions:packet.openQuestions,facts:packet.facts,inspected:packet.inspected,workstreams,required_role:options.roleFloor||null,eligible_targets:eligible,target_efforts:targetEfforts,target_execution_modes:targetExecutionModes,registry_version:REGISTRY_VERSION,policy_version:routing.version}
  const questions = {
    execution_lane: {type:'choice',instructions:laneInstructions('the phase task'),criteria:laneCriteria(externalCriteria)},
    native_target: {type:'choice',instructions:'Independently, IF a native worker is used, follow the fixed Luna Max research / Astra XHigh implementation and acceptance contract. Do not depend on another answer.',criteria:nativeCriteria},
    ...(Object.keys(externalCriteria).length?{external_target:{type:'choice',instructions:`Independently, IF an external worker is used, choose the most capable suitable external model for this task. ${qualityInstructions} Do not depend on another answer.`,criteria:externalCriteria}}:{}),
    effort: {type:'choice',instructions:'Independently estimate the smallest sufficient reasoning depth for this TASK. Do not condition on any other answer; code maps this level to a supported effort on the chosen model.',criteria:{low:'Simple localized analysis or mechanical change.',medium:'Ordinary bounded engineering or review.',high:'Difficult causal analysis or consequential correctness.',xhigh:'Very difficult cross-cutting reasoning.',max:'Exceptional reasoning depth is necessary.'}},
    ...workstreamQuestions(workstreams,options.env||process.env),
  }
  const cacheKey=createHash('sha256').update(JSON.stringify({state,questions})).digest('hex')
  if(options.useCache!==false&&cache.has(cacheKey))return{...structuredClone(cache.get(cacheKey)),cacheHit:true}
  const result = await askJev({ state, questions: {
    ...questions,
    task_type: {type:'choice',instructions:'Classify the primary task.',criteria:{retrieval:'Exact search or repository mapping.',implementation:'Bounded code change.',debugging:'Causal diagnosis.',review:'Independent verification.'}},
    complexity: {type:'choice',instructions:'Estimate size separately from risk.',criteria:{low:'Localized and mechanical.',medium:'Several related surfaces.',high:'Cross-cutting architecture or ambiguity.'}},
    risk: {type:'choice',instructions:'Assess consequence and trust boundaries separately from task size. Exact caller search is not high risk merely because a symbol contains a safety word.',criteria:{low:'Read-only or trivial.',normal:'Ordinary bounded engineering.',high:'Funds, auth, secrets, concurrency, production, or irreversible behavior.'}},
    worker: { type: 'choice', instructions: `Choose the role best suited to correctness and task risk. ${qualityInstructions} Never downgrade high-risk unknown-root-cause work. Scout is strictly read-only research, never implementation or final review.`, criteria: { scout: 'Repository search and reconnaissance only.', engineer: 'Bounded implementation with an established causal path.', deep_debugger: 'Ambiguous high-risk root cause, financial correctness, concurrency, distributed state or execution.' } },
    context_profile: { type: 'choice', instructions: 'Choose the smallest sufficient bounded context. Expanded requires concrete missing evidence, ambiguity, or high risk.', criteria: { tight: 'Localized work with strong symbol, file, or exact-search evidence.', normal: 'Ordinary bounded engineering using direct dependencies.', expanded: 'Current evidence is insufficient for genuinely ambiguous or high-risk work.' } },
    retrieval_mode: { type: 'choice', instructions: 'Choose the narrowest sufficient repository retrieval scope. Exploratory is exceptional.', criteria: { exact: 'Known symbols, exact hits, named files, and relevant excerpts only.', adjacent: 'Direct callers, callees, imports, and dependencies around known evidence.', exploratory: 'Broader investigation because root cause or context is genuinely unknown.' } },
    expand_context: { type: 'noul', instructions: 'Is more repository context required?', criteria: { true: 'More evidence is necessary.', false: 'Current evidence is sufficient.' } },
    parallel_required: {type:'noul',instructions:'Would multiple independent workers materially shorten the critical path?',criteria:{true:'Disjoint work has a concrete critical-path benefit.',false:'Use one worker.'}},
    parallel_justification: {type:'choice',instructions:'Why parallel work is or is not warranted.',criteria:{none:'No credible critical-path benefit.',independent:'Read-only or disjoint independent evidence.',critical_path:'Disjoint delivery materially shortens elapsed time.'}},
    verification: {type:'choice',instructions:'Choose the smallest realistic verification layer.',criteria:{unit:'Deterministic unit contract.',integration:'Cross-module/provider contract.',end_to_end:'Transport or user-visible end-to-end path.'}},
    review_required: { type: 'noul', instructions: 'Assess review value. Every implementation deterministically receives exactly one fresh read-only Astra XHigh final review; this advice cannot waive that gate.', criteria: { true: 'Implementation or consequential investigation.', false: 'Read-only research without implementation.' } }
  } }, {...options,taskContext:{task:packet.task,rootCause:packet.rootCause}})
  if(!result.available)return result
  const executionLane=normalizeExecutionLane(result.answers.execution_lane),nativeTarget=normalizeChoice(result.answers.native_target),externalTarget=normalizeChoice(result.answers.external_target)
  const workstreamAdvice=workstreams.map((workstream,index)=>{
    const prefix=`workstream_${index}`,lane=normalizeExecutionLane(result.answers[`${prefix}_execution_lane`]),native=normalizeChoice(result.answers[`${prefix}_native_target`]),external=normalizeChoice(result.answers[`${prefix}_external_target`])
    return{id:workstream.id,executionLane:lane,nativeTarget:native,externalTarget:external,target:lane?(lane.choice==='native_host'?native:external):null,effort:normalizeChoice(result.answers[`${prefix}_effort`]),laneAdvicePresent:Object.hasOwn(result.answers,`${prefix}_execution_lane`)}
  })
  const normalized={...result,cacheKey,cacheHit:false,executionLane,nativeTarget,externalTarget,workstreamAdvice,laneAdvicePresent:Object.hasOwn(result.answers,'execution_lane'),taskType:normalizeChoice(result.answers.task_type),complexity:normalizeChoice(result.answers.complexity),riskAdvice:normalizeChoice(result.answers.risk),worker:normalizeChoice(result.answers.worker),target:executionLane?(executionLane.choice==='native_host'?nativeTarget:externalTarget):normalizeChoice(result.answers.target),effort:normalizeChoice(result.answers.effort),contextProfile:normalizeContextProfile(result.answers.context_profile),retrievalMode:normalizeRetrievalMode(result.answers.retrieval_mode),expandContext:normalizeNoul(result.answers.expand_context),parallelRequired:normalizeNoul(result.answers.parallel_required),parallelJustification:normalizeChoice(result.answers.parallel_justification),verification:normalizeChoice(result.answers.verification),reviewRequired:normalizeNoul(result.answers.review_required)}
  if(options.useCache!==false)cache.set(cacheKey,structuredClone(normalized))
  return normalized
}
