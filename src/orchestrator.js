import { createEvidencePacket, CONTEXT_PROFILES } from './context/evidencePacket.js'
import { classifyRisk } from './router/risk.js'
import { deterministicRoute } from './router/deterministic.js'
import { askRoutingJev } from './router/jev.js'
import { nextAttemptState } from './policy/antiLoop.js'
import { createDelegation } from './providers/registry.js'
import { chooseTarget } from './router/targetSelection.js'
import { withDecisionTrace } from './router/decisionTrace.js'
import path from 'node:path'
import { COMMANDER, taskKind, reviewPolicy } from './policy/quality.js'
import { ARTIFACT_DIGEST, requiredVerification } from './policy/commitGate.js'
import { chooseReviewTarget } from './router/reviewSelection.js'

const rank = { scout: 0, engineer: 1, deep_debugger: 2, reviewer: 2, exceptional: 3 }
const workerRoles = new Set(['scout', 'engineer', 'deep_debugger', 'exceptional'])
const profileRank = { tight: 0, normal: 1, expanded: 2 }
const retrievalRank = { exact: 0, adjacent: 1, exploratory: 2 }
const number = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback
const threshold = (value, minimum) => Math.min(1, Math.max(minimum, number(value, minimum)))
const confident = (value, minimum) => typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= 1

function deterministicContext(packet, route) {
  const unknownHighRisk = packet.risk === 'high' && !packet.rootCause
  if (unknownHighRisk) return { contextProfile: 'expanded', retrievalMode: 'exploratory', reason: 'high-risk-root-cause-unknown' }
  if (route.role === 'scout') return { contextProfile: 'tight', retrievalMode: 'exact', reason: 'bounded-retrieval' }
  if (packet.rootCause || packet.files.length || packet.evidence.length) return { contextProfile: 'tight', retrievalMode: 'adjacent', reason: 'localized-evidence' }
  return { contextProfile: 'normal', retrievalMode: 'adjacent', reason: 'ordinary-engineering' }
}

function hasExpansionReason(packet) {
  return (packet.risk === 'high' && !packet.rootCause) || packet.openQuestions.length > 0 || (!packet.rootCause && packet.evidence.length === 0 && packet.files.length === 0)
}

function applyAdvice(packet, fallbackContext, advice, env) {
  const min = number(env.JEV_MIN_CONFIDENCE, 0.70)
  let contextProfile = fallbackContext.contextProfile
  let retrievalMode = fallbackContext.retrievalMode
  const profile = advice?.available && advice.contextProfile?.confidence >= min ? advice.contextProfile.choice : null
  const retrieval = advice?.available && advice.retrievalMode?.confidence >= min ? advice.retrievalMode.choice : null
  const expansionAllowed = hasExpansionReason(packet)
  if (profile && (profile !== 'expanded' || expansionAllowed)) contextProfile = profile
  if (retrieval && (retrieval !== 'exploratory' || expansionAllowed)) retrievalMode = retrieval
  if (packet.risk === 'high' && !packet.rootCause) {
    if (profileRank[contextProfile] < profileRank.expanded) contextProfile = 'expanded'
    if (retrievalRank[retrievalMode] < retrievalRank.exploratory) retrievalMode = 'exploratory'
  }
  if (advice?.expandContext?.probability < min && !(packet.risk === 'high' && !packet.rootCause)) {
    if (profileRank[contextProfile] > profileRank.normal) contextProfile = 'normal'
    if (retrievalRank[retrievalMode] > retrievalRank.adjacent) retrievalMode = 'adjacent'
  }
  return { contextProfile, retrievalMode, expansionAllowed, reason: expansionAllowed ? 'evidence-based-expansion-eligible' : 'expansion-not-justified' }
}

function mandatoryRole(input, packet) {
  if ((input.attempts || []).length >= 2) return 'exceptional'
  if (packet.risk === 'high' && !packet.rootCause) return 'deep_debugger'
  return null
}

function chooseWorker(fallback, mandatory, advice, env, kind) {
  const minimum = threshold(env.JEV_MIN_CONFIDENCE, 0.70)
  const jevChoice = advice?.available ? advice.worker?.choice : null
  const valid = workerRoles.has(jevChoice)
  const floorMet = (!mandatory || (valid && rank[jevChoice] >= rank[mandatory])) && (kind==='research'||jevChoice!=='scout')
  const accepted = Boolean(valid && floorMet && confident(advice?.worker?.confidence, minimum))
  return {
    route: accepted ? { role: jevChoice, action: 'delegate', reason: 'jev' } : fallback,
    trace: {
      source: accepted ? 'jev' : 'deterministic-fallback',
      fallback: fallback.role,
      mandatoryFloor: mandatory,
      jev: { choice: jevChoice, confidence: advice?.worker?.confidence ?? null, threshold: minimum, accepted, reason: accepted ? 'validated-jev-choice' : (!valid ? 'missing-or-invalid-choice' : (!floorMet ? 'deterministic-role-floor' : 'insufficient-confidence')) }
    }
  }
}

function normalizeWorkstreams(input, risk = 'normal') {
  const values = Array.isArray(input.workstreams) ? input.workstreams.slice(0, 3) : []
  const issues = []
  if (Array.isArray(input.workstreams) && input.workstreams.length > 3) issues.push({ reason: 'too-many-workstreams' })
  for (const value of values) {
    if (!value || typeof value.task !== 'string' || !value.task.trim() || ['files', 'tests', 'dependsOn', 'evidence'].some(key => value[key] !== undefined && (!Array.isArray(value[key]) || value[key].some(item => typeof item !== 'string' || !item.trim()))) || (value?.rootCause != null && typeof value.rootCause !== 'string')) issues.push({ reason: 'invalid-workstream' })
    if (value?.files?.length > 3 || value?.tests?.length > 2) issues.push({ reason: 'workstream-ownership-exceeds-assignment-bounds' })
    if (value?.dependsOn?.length > 3) issues.push({ reason: 'truncated-workstream-dependencies' })
    if (['files', 'tests', 'dependsOn'].some(key => value?.[key]?.some(item => item.length > 500))) issues.push({ reason: 'oversized-workstream-identifier' })
  }
  const workstreams = values.map((value, index) => {
    const task=String(value?.task||''),workstreamRisk=risk==='high'||classifyRisk(task).risk==='high'?'high':risk
    const bounded=createEvidencePacket({task,risk:workstreamRisk,rootCause:value?.rootCause??null,evidence:Array.isArray(value?.evidence)?value.evidence:[],excerpts:value?.excerpts,facts:value?.facts,inspected:value?.inspected},{contextProfile:'tight'})
    return{
      id: String(value?.id || `workstream-${index + 1}`).slice(0, 80),
      task: bounded.task,
      taskKind: taskKind({...bounded,files:value?.files||[]},value?.taskKind),
      risk: workstreamRisk,
      rootCause: bounded.rootCause,
      evidence: bounded.evidence,
      excerpts: bounded.excerpts, facts: bounded.facts, inspected: bounded.inspected,
      files: [...new Set((Array.isArray(value?.files) ? value.files : []).map(String).filter(Boolean))].slice(0, 3),
      tests: [...new Set((Array.isArray(value?.tests) ? value.tests : []).map(String).filter(Boolean))].slice(0, 2),
      dependsOn: [...new Set((Array.isArray(value?.dependsOn) ? value.dependsOn : []).map(String).filter(Boolean))].slice(0, 3),
      truncation: bounded.truncation
    }
  }).filter(value => value.task)
  const owners = new Map(), conflicts = [], ids = new Set()
  for (const workstream of workstreams) {
    if (ids.has(workstream.id)) issues.push({ workstream: workstream.id, reason: 'duplicate-workstream-id' })
    ids.add(workstream.id)
    if (!workstream.files.length && !workstream.tests.length) issues.push({ workstream: workstream.id, reason: 'missing-file-ownership' })
    if (workstream.dependsOn.length) issues.push({ workstream: workstream.id, reason: 'dependent-workstream' })
    for (const file of [...workstream.files, ...workstream.tests]) {
      const raw=file.replaceAll('\\', '/'),canonical = path.posix.normalize(raw).toLowerCase()
      const unsafe=/[*?\[\]{}]/.test(raw)||raw.split('/').includes('..')||/(^|\/)(\.env|\.git|secrets?)(\/|$)/i.test(raw)||canonical === '.'||canonical === '..'||canonical.startsWith('../')||path.posix.isAbsolute(canonical)||/^[a-z]:/.test(canonical)
      if (unsafe) { issues.push({ workstream: workstream.id, file, reason: 'ambiguous-file-ownership' }); continue }
      for (const [owned, owner] of owners) {
        if (owner !== workstream.id && (canonical === owned || canonical.startsWith(`${owned}/`) || owned.startsWith(`${canonical}/`))) conflicts.push({ file, workstreams: [owner, workstream.id] })
      }
      owners.set(canonical, workstream.id)
    }
  }
  return { workstreams, conflicts, issues, nonOverlapping: conflicts.length === 0 && issues.length === 0 }
}

function parallelPlan(input, advice, env, normalized = normalizeWorkstreams(input)) {
  const minimum = threshold(env.JEV_PARALLEL_THRESHOLD, 0.80)
  const jevParallel = advice?.available && confident(advice.parallelRequired?.probability, minimum) && confident(advice.parallelJustification?.confidence, threshold(env.JEV_MIN_CONFIDENCE, 0.70)) && ['independent', 'critical_path'].includes(advice?.parallelJustification?.choice)
  const suppliedParallel = normalized.workstreams.length > 1 && normalized.nonOverlapping
  const recommended = suppliedParallel ? normalized.workstreams.length : (jevParallel ? 3 : 1)
  const configured = Math.min(3, Math.max(1, Math.trunc(number(env.HARNESS_MAX_PARALLEL, 3))))
  const effective = normalized.nonOverlapping ? Math.min(recommended, configured) : 1
  return {
    recommended,
    effective,
    configured,
    decisionSource: suppliedParallel ? 'validated-workstreams' : (jevParallel ? 'jev' : 'deterministic-single'),
    probability: advice?.parallelRequired?.probability ?? null,
    threshold: minimum,
    justification: suppliedParallel ? 'independent' : (advice?.parallelJustification?.choice || 'none'),
    workstreams: normalized.workstreams,
    conflicts: normalized.conflicts,
    issues: normalized.issues,
    nonOverlapping: normalized.nonOverlapping
  }
}

const executionContext = input => ({
  workspace: String(input.workspace || '').slice(0, 1000),
  ownerAuthorizedRetry: Boolean(input.ownerAuthorizedRetry),
  retryReason: String(input.retryReason || '').slice(0, 500),
  attempts: (input.attempts || []).length,
  newEvidence: Boolean(input.newEvidence)
})
const dispatchFor = target => target.executionMode === 'external_api' ? {
  tool: 'execute_routed_task',
  instruction: 'Execute this server-held decision using decisionId and optional budget/deadline only. Do not reroute or pass model, evidence, or authority overrides. The parent applies and verifies any returned patch.'
} : null
function handoffFor(target, { strategy = 'single', maxAgents = 1 } = {}) {
  if (target.executionMode !== 'native_host') return null
  return {
    required: true, mode: 'native_host', scope: target.role==='reviewer'?'fresh-final-reviewer':target.model==='gpt-6-astra'?'commander':'subagent-only', parentModelUnchanged: true, billingSource: 'chatgpt_plan',
    readOnly:target.role==='reviewer'||target.role==='scout', fresh:target.role==='reviewer',
    role: target.role, provider: target.provider, model: target.model, effort: target.effort,
    orchestration: { strategy:target.role==='reviewer'||target.role==='scout'?'single':target.model==='gpt-6-astra'?'commander':strategy, maxAgents:target.role==='scout'||target.model==='gpt-6-astra'?1:maxAgents, routeOncePerPhase: true, instruction: target.role==='reviewer'
      ? 'Spawn exactly one fresh read-only native Astra XHigh final reviewer for the complete integrated diff after verification. Return acceptance or blocking findings; never edit or commit.'
      : target.role==='scout' ? 'Spawn one bounded Luna Max read-only researcher. It may read, trace and report concise findings; it must not edit, implement, review final work, approve changes or commit.'
      : target.model==='gpt-6-astra' ? 'The permanent native Astra XHigh commander owns this implementation/integration work. Keep the parent model unchanged and do not spawn another coding commander. Astra applies candidate patches, verifies, obtains final acceptance, and checks the commit gate.' : strategy === 'single'
      ? 'Spawn one bounded native Codex subagent when delegation is useful. Keep the parent model unchanged; the parent integrates and verifies.'
      : `Spawn up to ${maxAgents} native Codex subagents concurrently for independent, non-overlapping workstreams. Keep the parent model unchanged; the parent integrates and verifies.` }
  }
}
function scopedWorkstreamAdvice(advice, index, expectedIds) {
  if (!advice?.available) return null
  const values=advice.workstreamAdvice
  const valid=Array.isArray(values)&&values.length===expectedIds.length&&values.every((value,position)=>
    value?.id===expectedIds[position]&&value.laneAdvicePresent&&value.executionLane&&value.nativeTarget&&value.effort&&
    (value.executionLane.choice!=='external_api'||value.externalTarget))
  return valid?{...advice,...values[index]}:null
}
function workstreamPacket(workstream, input, contextProfile) {
  const packet=createEvidencePacket({
    task: workstream.task, risk: workstream.risk, rootCause: workstream.rootCause, evidence: workstream.evidence,
    files: workstream.files, tests: workstream.tests, excerpts:workstream.excerpts, facts:workstream.facts, inspected:workstream.inspected, protectedBoundaries: input.protectedBoundaries || []
  }, { contextProfile })
  packet.truncation.removed=[...new Set([...(workstream.truncation?.removed||[]),...packet.truncation.removed])]
  packet.truncation.occurred=Boolean(workstream.truncation?.occurred||packet.truncation.occurred)
  return packet
}
function strongestRoute(...routes) {
  const valid=routes.filter(value=>value?.role&&Object.hasOwn(rank,value.role))
  return valid.reduce((strongest,value)=>rank[value.role]>rank[strongest.role]?value:strongest)
}

export async function planTask(input, options = {}) {
  const env = options.env || process.env
  const classifiedRisk = classifyRisk(input.task).risk
  const risk = input.risk === 'high' || classifiedRisk === 'high' ? 'high' : (input.risk || classifiedRisk)
  const initialPacket = createEvidencePacket({ ...input, risk }, { contextProfile: 'normal' })
  const kind=options.review?'review':taskKind(initialPacket,input.taskKind)
  const normalizedWorkstreams = normalizeWorkstreams(options.review?{}:input, risk)
  const hasImplementationWorkstream=normalizedWorkstreams.workstreams.some(value=>value.taskKind!=='research')
  const implementationRequired=!options.review&&(kind!=='research'||hasImplementationWorkstream)
  const attempt = nextAttemptState({
    attempts: input.attempts || [],
    newEvidence: Boolean(input.newEvidence),
    ownerAuthorizedRetry: Boolean(input.ownerAuthorizedRetry),
    retryReason: input.retryReason
  })
  if (!attempt.allowed) return withDecisionTrace({ packet: initialPacket, route: { action: attempt.action, reason: attempt.reason }, delegation: null, advice: null })

  const fallback = options.review ? { role: 'reviewer', action: 'delegate', reason: 'independent-review-required' } : deterministicRoute({ task: initialPacket.task, risk, rootCause: initialPacket.rootCause, attempts: (input.attempts || []).length, taskKind:kind })
  const mandatory = options.review ? 'reviewer' : mandatoryRole(input, initialPacket)
  let advice = null
  const jevWorkstreams=normalizedWorkstreams.nonOverlapping&&normalizedWorkstreams.workstreams.length>0?normalizedWorkstreams.workstreams:[]
  if (options.useJev !== false && !options.review) advice = await askRoutingJev(initialPacket, { ...options, roleFloor: mandatory || fallback.role, taskKind:kind, workstreams:jevWorkstreams })
  const worker = options.review ? { route: fallback, trace: { source: 'deterministic-review-policy', mandatoryFloor: 'reviewer' } } : chooseWorker(fallback, mandatory, advice, env,kind)
  const route = worker.route
  const contextPolicy = applyAdvice(initialPacket, deterministicContext(initialPacket, route), advice, env)
  // Do not cut a complete review or prepared source packet back to tight merely
  // because it names files. Pick the smallest finite envelope that fits counts.
  if(options.review||input.excerpts?.length){
    const fits=Object.keys(CONTEXT_PROFILES).find(profile=>['files','tests','docs','evidence','openQuestions','facts','inspected','excerpts'].every(key=>(input[key]?.length||0)<=(CONTEXT_PROFILES[profile][key==='excerpts'?'files':key]||0)))
    if(fits&&profileRank[fits]>profileRank[contextPolicy.contextProfile])contextPolicy.contextProfile=fits
    if(options.review)contextPolicy.retrievalMode='exact'
  }
  const packet = createEvidencePacket({ ...input, risk }, { contextProfile: contextPolicy.contextProfile })
  const reviewContext=options.review && ARTIFACT_DIGEST.test(input.reviewContext?.artifactDigest||'') && typeof input.reviewContext?.commanderAgentId==='string' && input.reviewContext.commanderAgentId.trim()
    ? {artifactDigest:input.reviewContext.artifactDigest,commanderAgentId:input.reviewContext.commanderAgentId.slice(0,120),requiredChecks:requiredVerification(),implementationProviders:input.reviewContext.implementationProviders,changedFiles:input.reviewContext.changedFiles,evidenceComplete:input.reviewContext.evidenceComplete===true} : null
  if(reviewContext)packet.reviewContext=reviewContext
  const reviewProbability = advice?.reviewRequired?.probability ?? 0
  const review = options.review?{...reviewPolicy('research','normal'),reason:'final-review-in-progress',required:false,recommended:false}:reviewPolicy(implementationRequired?'implementation':kind,risk,reviewProbability)
  const policy = { ...contextPolicy, taskKind:kind, review, commander:{...COMMANDER}, commitGate:{required:implementationRequired,tool:'check_action',action:'commit',evidenceSource:'host-attested'} }
  const requested = input.requestedRoute || null
  const overrides = []
  const target = options.review ? await chooseReviewTarget(packet,input,options) : chooseTarget(route, requested, Boolean(input.requestedRouteAuthorized), advice, env, mandatory, overrides,{...packet,taskKind:kind})
  if(options.review)advice=target.advice
  policy.evidencePreparation={hasSourceExcerpts:packet.excerpts.length>0,sourcePaths:packet.excerpts.map(value=>value.path),instruction:'Supply source/diff excerpts for external work. A file path is not file content. After discovery resolves the cause, prepare one bounded assignment or disjoint workstreams; that material evidence change may justify one new route.'}
  const parallel = parallelPlan(input, advice, env, normalizedWorkstreams)
  const phaseExecutionContext=executionContext(input)
  const workstreamPlans=[]
  if(parallel.nonOverlapping&&parallel.workstreams.length>0){
    const expectedIds=parallel.workstreams.map(value=>value.id)
    for(const [index,workstream] of parallel.workstreams.entries()){
      const scopedAdvice=scopedWorkstreamAdvice(advice,index,expectedIds),workstreamOverrides=[]
      const workstreamInitialPacket=workstreamPacket(workstream,input,'normal')
      const workstreamFallback=deterministicRoute({task:workstream.task,risk:workstream.risk,rootCause:workstream.rootCause,attempts:(input.attempts||[]).length,taskKind:workstream.taskKind})
      const workstreamMandatory=mandatoryRole(input,workstreamInitialPacket)
      const workstreamRoute=strongestRoute(workstreamFallback,workstreamMandatory?{role:workstreamMandatory,action:'delegate',reason:'deterministic-workstream-floor'}:null)
      const workstreamContextPolicy=applyAdvice(workstreamInitialPacket,deterministicContext(workstreamInitialPacket,workstreamRoute),scopedAdvice,env)
      const workstreamEvidence=workstreamPacket(workstream,input,workstreamContextPolicy.contextProfile)
      const workstreamReviewProbability=scopedAdvice?.reviewRequired?.probability??0
      const workstreamReview=reviewPolicy(workstream.taskKind,workstream.risk,workstreamReviewProbability)
      const workstreamPolicy={...workstreamContextPolicy,taskKind:workstream.taskKind,review:workstreamReview,commander:{...COMMANDER},commitGate:{...policy.commitGate,required:workstream.taskKind!=='research'}}
      const workstreamTarget=chooseTarget(workstreamRoute,requested,Boolean(input.requestedRouteAuthorized),scopedAdvice,env,workstreamMandatory,workstreamOverrides,{...workstreamEvidence,taskKind:workstream.taskKind})
      const workstreamWorkerTrace=workstreamRoute.role===route.role?worker.trace:{source:'deterministic-workstream-floor',fallback:route.role,mandatoryFloor:workstreamMandatory,applied:workstreamRoute.role}
      const workstreamDecision={
        requested,recommended:workstreamTarget.recommended,effective:workstreamTarget.effective,
        selection:{worker:workstreamWorkerTrace,target:workstreamTarget.trace},overrides:workstreamOverrides,
        handoff:handoffFor(workstreamTarget.effective),dispatch:dispatchFor(workstreamTarget.effective),parallel:null,
        workstream:{id:workstream.id},executionContext:phaseExecutionContext,
        planReuse:{routingPhaseId:`${input.routingPhaseId||'phase'}:${workstream.id}`,routeOncePerPhase:true,instruction:'Execute or hand off this pinned workstream decision once; the parent integrates and verifies it.'}
      }
      workstreamPlans.push(withDecisionTrace({
        packet:workstreamEvidence,route:{...workstreamRoute,...workstreamTarget.effective,requested,routingDecision:workstreamDecision},
        delegation:createDelegation(workstreamTarget.effective.role,workstreamEvidence,workstreamPolicy,workstreamTarget.effective),
        advice:scopedAdvice,policy:workstreamPolicy,review:workstreamReview,routingDecision:workstreamDecision,commander:{...COMMANDER}
      }))
    }
  }
  parallel.assignments=workstreamPlans.map((plan,index)=>({
    id:parallel.workstreams[index].id,decisionId:plan.routingDecision.decisionId,effective:plan.routingDecision.effective,
    selection:plan.routingDecision.selection.target,overrides:plan.routingDecision.overrides,
    handoff:plan.routingDecision.handoff,dispatch:plan.routingDecision.dispatch,delegation:plan.delegation,
    evidenceDigest:plan.routingDecision.evidenceDigest
  }))
  const hasAssignments=parallel.assignments.length>0
  const modes=new Set(parallel.assignments.map(value=>value.effective.executionMode))
  const handoff = hasAssignments ? {
    required:true,mode:modes.size>1?'mixed':modes.values().next().value,scope:'workstream-assignments',parentModelUnchanged:true,
    billingSource:modes.size>1?'mixed':(modes.has('native_host')?'chatgpt_plan':'external_api'),
    orchestration:{strategy:'heterogeneous-non-overlapping',maxAgents:parallel.effective,routeOncePerPhase:true,
      instruction:'Use each workstream assignment exactly once. Spawn Luna Max research assignments; keep Astra implementation assignments in the commander; execute external assignments by decisionId. Run at most maxAgents concurrently. Astra integrates and verifies all results, then obtains one independent review of the complete integrated diff.'}
  } : handoffFor(target.effective,{strategy:parallel.effective>1?'parallel-non-overlapping':'single',maxAgents:parallel.effective})
  const selection = { worker: worker.trace, target: target.trace }
  const routingDecision = {
    requested,
    recommended: target.recommended,
    effective: target.effective,
    selection,
    overrides,
    handoff,
    dispatch: hasAssignments ? (modes.has('external_api') ? {tool:'execute_routed_task',perWorkstream:true,instruction:'Execute only external workstream assignment decisionIds. Native assignments are host subagent handoffs. Do not reroute or substitute targets.'} : null) : dispatchFor(target.effective),
    parallel,
    executionContext: phaseExecutionContext,
    reviewContext,
    planReuse: {
      routingPhaseId: input.routingPhaseId || null,
      routeOncePerPhase: true,
      instruction: 'Reuse this route for the current meaningful build phase. Route again only when risk, scope, causal evidence, or provider readiness materially changes.'
    }
  }
  return withDecisionTrace({
    packet,
    route: { ...route, ...target.effective, requested, routingDecision },
    delegation: target.effective.role ? createDelegation(target.effective.role, packet, policy, target.effective) : null,
    advice,
    policy,
    review,
    routingDecision,
    commander: { ...COMMANDER },
    _workstreamPlans: workstreamPlans
  })
}
