import { createHash } from 'node:crypto'
import { listModels, REGISTRY_VERSION } from '../providers/catalog.js'
import routing from '../../config/routing.json' with {type:'json'}
import { getAccountingStore } from '../execution/executor.js'
import { taskIdentityFromContext, digestValue } from '../execution/taskIdentity.js'
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
  ? { choice: answer.choice, probabilities: answer.probabilities || {}, confidence: number(answer.confidence, 0) } : null
export const normalizeNoul = answer => answer?.type === 'noul' ? { probability: number(answer.noul, 0) } : null
export const normalizeContextProfile = answer => { const value = normalizeChoice(answer); return value && CONTEXT_PROFILES.has(value.choice) ? value : null }
export const normalizeRetrievalMode = answer => { const value = normalizeChoice(answer); return value && RETRIEVAL_MODES.has(value.choice) ? value : null }
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
      const usage={inputTokens:Number(raw.usage?.input_tokens||raw.usage?.inputTokens||0),outputTokens:Number(raw.usage?.output_tokens||raw.usage?.outputTokens||0)}
      const job=await ledger.finalize(reservation.job.id,{status:'completed',usage,actualCostUsd:availability.callCostUsd})
      return { available: true, reason: 'jev', model: raw.model, answers: raw.answers || {}, usage: raw.usage || {}, retries: attempt,job,taskId }
    } catch (error) {
      if (attempt < maxRetries && (error?.name === 'AbortError' || error instanceof TypeError)) { clearTimeout(timer); await sleep(250 * (2 ** attempt)); continue }
      const reason=error?.name === 'AbortError' ? 'jev-timeout' : 'jev-network-error',job=await ledger.finalize(reservation.job.id,{status:'failed',error:reason,uncertainBilling:true})
      return { available: false, reason, retries: attempt,job,taskId }
    } finally { clearTimeout(timer) }
  }
}

export async function askRoutingJev(packet, options = {}) {
  const availability=jevAvailability(options.env||process.env)
  if(!availability.available)return availability
  const eligible=(options.eligibleModels||listModels()).flatMap(model=>model.efforts.map(effort=>`${model.provider}:${model.id}:${effort}`))
  const state={task:packet.task,risk:packet.risk,root_cause_known:Boolean(packet.rootCause),evidence:packet.evidence,files:packet.files,open_questions:packet.openQuestions,facts:packet.facts,inspected:packet.inspected,eligible_targets:eligible,registry_version:REGISTRY_VERSION,policy_version:routing.version}
  const cacheKey=createHash('sha256').update(JSON.stringify(state)).digest('hex')
  if(options.useCache!==false&&cache.has(cacheKey))return{...structuredClone(cache.get(cacheKey)),cacheHit:true}
  const result = await askJev({ state, questions: {
    task_type: {type:'choice',instructions:'Classify the primary task.',criteria:{retrieval:'Exact search or repository mapping.',implementation:'Bounded code change.',debugging:'Causal diagnosis.',review:'Independent verification.'}},
    complexity: {type:'choice',instructions:'Estimate size separately from risk.',criteria:{low:'Localized and mechanical.',medium:'Several related surfaces.',high:'Cross-cutting architecture or ambiguity.'}},
    risk: {type:'choice',instructions:'Assess consequence and trust boundaries separately from task size. Exact caller search is not high risk merely because a symbol contains a safety word.',criteria:{low:'Read-only or trivial.',normal:'Ordinary bounded engineering.',high:'Funds, auth, secrets, concurrency, production, or irreversible behavior.'}},
    worker: { type: 'choice', instructions: 'Choose the cheapest capable worker. Never downgrade high-risk unknown-root-cause work.', criteria: { scout: 'Repository search and reconnaissance only.', engineer: 'Bounded implementation with an established causal path.', deep_debugger: 'Ambiguous high-risk root cause, financial correctness, concurrency, distributed state or execution.' } },
    target: {type:'choice',instructions:'Choose exactly one target from eligible_targets in state. Never invent or substitute a model or effort.',criteria:Object.fromEntries(eligible.map(value=>[value,value]))},
    context_profile: { type: 'choice', instructions: 'Choose the smallest sufficient bounded context. Expanded requires concrete missing evidence, ambiguity, or high risk.', criteria: { tight: 'Localized work with strong symbol, file, or exact-search evidence.', normal: 'Ordinary bounded engineering using direct dependencies.', expanded: 'Current evidence is insufficient for genuinely ambiguous or high-risk work.' } },
    retrieval_mode: { type: 'choice', instructions: 'Choose the narrowest sufficient repository retrieval scope. Exploratory is exceptional.', criteria: { exact: 'Known symbols, exact hits, named files, and relevant excerpts only.', adjacent: 'Direct callers, callees, imports, and dependencies around known evidence.', exploratory: 'Broader investigation because root cause or context is genuinely unknown.' } },
    expand_context: { type: 'noul', instructions: 'Is more repository context required?', criteria: { true: 'More evidence is necessary.', false: 'Current evidence is sufficient.' } },
    parallel_required: {type:'noul',instructions:'Would multiple independent workers materially shorten the critical path?',criteria:{true:'Disjoint work has a concrete critical-path benefit.',false:'Use one worker.'}},
    parallel_justification: {type:'choice',instructions:'Why parallel work is or is not warranted.',criteria:{none:'No credible critical-path benefit.',independent:'Read-only or disjoint independent evidence.',critical_path:'Disjoint delivery materially shortens elapsed time.'}},
    verification: {type:'choice',instructions:'Choose the smallest realistic verification layer.',criteria:{unit:'Deterministic unit contract.',integration:'Cross-module/provider contract.',end_to_end:'Transport or user-visible end-to-end path.'}},
    review_required: { type: 'noul', instructions: 'Should this change receive an independent bounded review?', criteria: { true: 'Meaningful normal/high-risk change.', false: 'Trivial low-risk work.' } }
  } }, {...options,taskContext:{task:packet.task,rootCause:packet.rootCause}})
  if(!result.available)return result
  const normalized={...result,cacheKey,cacheHit:false,taskType:normalizeChoice(result.answers.task_type),complexity:normalizeChoice(result.answers.complexity),riskAdvice:normalizeChoice(result.answers.risk),worker:normalizeChoice(result.answers.worker),target:normalizeChoice(result.answers.target),contextProfile:normalizeContextProfile(result.answers.context_profile),retrievalMode:normalizeRetrievalMode(result.answers.retrieval_mode),expandContext:normalizeNoul(result.answers.expand_context),parallelRequired:normalizeNoul(result.answers.parallel_required),parallelJustification:normalizeChoice(result.answers.parallel_justification),verification:normalizeChoice(result.answers.verification),reviewRequired:normalizeNoul(result.answers.review_required)}
  if(options.useCache!==false)cache.set(cacheKey,structuredClone(normalized))
  return normalized
}
