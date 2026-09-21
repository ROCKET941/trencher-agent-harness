import { createEvidencePacket } from './context/evidencePacket.js'
import { classifyRisk } from './router/risk.js'
import { deterministicRoute } from './router/deterministic.js'
import { askRoutingJev } from './router/jev.js'
import { nextAttemptState } from './policy/antiLoop.js'
import { createDelegation } from './providers/registry.js'
import { chooseTarget } from './router/targetSelection.js'
import { withDecisionTrace } from './router/decisionTrace.js'
import path from 'node:path'

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

function chooseWorker(fallback, mandatory, advice, env) {
  const minimum = threshold(env.JEV_MIN_CONFIDENCE, 0.70)
  const jevChoice = advice?.available ? advice.worker?.choice : null
  const valid = workerRoles.has(jevChoice)
  const floorMet = !mandatory || (valid && rank[jevChoice] >= rank[mandatory])
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

function normalizeWorkstreams(input) {
  const values = Array.isArray(input.workstreams) ? input.workstreams.slice(0, 3) : []
  const issues = []
  if (Array.isArray(input.workstreams) && input.workstreams.length > 3) issues.push({ reason: 'too-many-workstreams' })
  for (const value of values) {
    if (!value || typeof value.task !== 'string' || !value.task.trim() || ['files', 'tests', 'dependsOn'].some(key => value[key] !== undefined && (!Array.isArray(value[key]) || value[key].some(item => typeof item !== 'string' || !item.trim())))) issues.push({ reason: 'invalid-workstream' })
    if (value?.files?.length > 12 || value?.tests?.length > 8 || value?.dependsOn?.length > 3) issues.push({ reason: 'truncated-workstream-ownership' })
  }
  const workstreams = values.map((value, index) => ({
    id: String(value?.id || `workstream-${index + 1}`).slice(0, 80),
    task: String(value?.task || '').slice(0, 1000),
    files: [...new Set((Array.isArray(value?.files) ? value.files : []).map(String).filter(Boolean))].slice(0, 12),
    tests: [...new Set((Array.isArray(value?.tests) ? value.tests : []).map(String).filter(Boolean))].slice(0, 8),
    dependsOn: [...new Set((Array.isArray(value?.dependsOn) ? value.dependsOn : []).map(String).filter(Boolean))].slice(0, 3)
  })).filter(value => value.task)
  const owners = new Map(), conflicts = [], ids = new Set()
  for (const workstream of workstreams) {
    if (ids.has(workstream.id)) issues.push({ workstream: workstream.id, reason: 'duplicate-workstream-id' })
    ids.add(workstream.id)
    if (!workstream.files.length && !workstream.tests.length) issues.push({ workstream: workstream.id, reason: 'missing-file-ownership' })
    if (workstream.dependsOn.length) issues.push({ workstream: workstream.id, reason: 'dependent-workstream' })
    for (const file of [...workstream.files, ...workstream.tests]) {
      const canonical = path.posix.normalize(file.replaceAll('\\', '/')).toLowerCase()
      if (/[*?\[\]{}]/.test(canonical) || canonical === '.' || canonical === '..' || canonical.startsWith('../') || path.posix.isAbsolute(canonical) || /^[a-z]:/.test(canonical)) issues.push({ workstream: workstream.id, file, reason: 'ambiguous-file-ownership' })
      for (const [owned, owner] of owners) {
        if (owner !== workstream.id && (canonical === owned || canonical.startsWith(`${owned}/`) || owned.startsWith(`${canonical}/`))) conflicts.push({ file, workstreams: [owner, workstream.id] })
      }
      owners.set(canonical, workstream.id)
    }
  }
  return { workstreams, conflicts, issues, nonOverlapping: conflicts.length === 0 && issues.length === 0 }
}

function parallelPlan(input, advice, env) {
  const minimum = threshold(env.JEV_PARALLEL_THRESHOLD, 0.80)
  const normalized = normalizeWorkstreams(input)
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

export async function planTask(input, options = {}) {
  const env = options.env || process.env
  const classifiedRisk = classifyRisk(input.task).risk
  const risk = input.risk === 'high' || classifiedRisk === 'high' ? 'high' : (input.risk || classifiedRisk)
  const initialPacket = createEvidencePacket({ ...input, risk }, { contextProfile: 'normal' })
  const attempt = nextAttemptState({
    attempts: input.attempts || [],
    newEvidence: Boolean(input.newEvidence),
    ownerAuthorizedRetry: Boolean(input.ownerAuthorizedRetry),
    retryReason: input.retryReason
  })
  if (!attempt.allowed) return withDecisionTrace({ packet: initialPacket, route: { action: attempt.action, reason: attempt.reason }, delegation: null, advice: null })

  const fallback = options.review ? { role: 'reviewer', action: 'delegate', reason: 'independent-review-required' } : deterministicRoute({ task: initialPacket.task, risk, rootCause: initialPacket.rootCause, attempts: (input.attempts || []).length })
  const mandatory = options.review ? 'reviewer' : mandatoryRole(input, initialPacket)
  let advice = null
  if (options.useJev !== false) advice = await askRoutingJev(initialPacket, { ...options, roleFloor: mandatory || 'scout' })
  const worker = options.review ? { route: fallback, trace: { source: 'deterministic-review-policy', mandatoryFloor: 'reviewer' } } : chooseWorker(fallback, mandatory, advice, env)
  const route = worker.route
  const contextPolicy = applyAdvice(initialPacket, deterministicContext(initialPacket, route), advice, env)
  const packet = createEvidencePacket({ ...input, risk }, { contextProfile: contextPolicy.contextProfile })
  const reviewProbability = advice?.reviewRequired?.probability ?? 0
  const reviewThreshold = number(env.JEV_REVIEW_THRESHOLD, 0.70)
  const review = {
    required: risk === 'high',
    recommended: risk === 'high' || reviewProbability >= reviewThreshold,
    reason: risk === 'high' ? 'deterministic-high-risk-policy' : (reviewProbability >= reviewThreshold ? 'jev' : 'not-required'),
    probability: reviewProbability
  }
  const policy = { ...contextPolicy, review }
  const requested = input.requestedRoute || null
  const overrides = []
  const target = chooseTarget(route, requested, Boolean(input.requestedRouteAuthorized), advice, env, mandatory, overrides)
  const parallel = parallelPlan(input, advice, env)
  const handoff = target.effective.executionMode === 'native_host' ? {
    required: true,
    mode: 'native_host',
    scope: 'subagent-only',
    parentModelUnchanged: true,
    billingSource: 'chatgpt_plan',
    role: target.effective.role,
    provider: target.effective.provider,
    model: target.effective.model,
    effort: target.effective.effort,
    orchestration: {
      strategy: parallel.effective > 1 ? 'parallel-non-overlapping' : 'single',
      maxAgents: parallel.effective,
      routeOncePerPhase: true,
      instruction: parallel.effective > 1
        ? `Spawn up to ${parallel.effective} native Codex subagents concurrently for independent, non-overlapping workstreams. Keep the parent model unchanged; the parent integrates and verifies.`
        : 'Spawn one bounded native Codex subagent when delegation is useful. Keep the parent model unchanged; the parent integrates and verifies.'
    }
  } : null
  const selection = { worker: worker.trace, target: target.trace }
  const routingDecision = {
    requested,
    recommended: target.recommended,
    effective: target.effective,
    selection,
    overrides,
    handoff,
    dispatch: target.effective.executionMode === 'external_api' ? {
      tool: 'execute_routed_task',
      instruction: 'Execute this server-held decision using decisionId and optional budget/deadline only. Do not reroute, substitute a native worker, or pass model/evidence overrides. The external delegate sees only the supplied packet; the parent applies and verifies any returned patch.'
    } : null,
    parallel,
    executionContext: {
      workspace: String(input.workspace || '').slice(0, 1000),
      ownerAuthorizedRetry: Boolean(input.ownerAuthorizedRetry),
      retryReason: String(input.retryReason || '').slice(0, 500),
      attempts: (input.attempts || []).length,
      newEvidence: Boolean(input.newEvidence)
    },
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
    commander: { mode: 'host', apiCommander: false }
  })
}
