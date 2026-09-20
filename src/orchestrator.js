import { createEvidencePacket } from './context/evidencePacket.js'
import { classifyRisk } from './router/risk.js'
import { deterministicRoute } from './router/deterministic.js'
import { askRoutingJev } from './router/jev.js'
import { nextAttemptState } from './policy/antiLoop.js'
import { createDelegation } from './providers/registry.js'
import { resolveRoleTarget } from './execution/roleResolver.js'
import { validateModel, eligibleForRole } from './providers/catalog.js'
import { executionModeForProvider } from './policy/providerExecution.js'

const rank = { scout: 0, engineer: 1, deep_debugger: 2, reviewer: 2, exceptional: 3 }
const workerRoles = new Set(['scout', 'engineer', 'deep_debugger', 'exceptional'])
const profileRank = { tight: 0, normal: 1, expanded: 2 }
const retrievalRank = { exact: 0, adjacent: 1, exploratory: 2 }
const number = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback

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

function decodeTarget(choice) {
  if (typeof choice !== 'string') return null
  const [provider, ...rest] = choice.split(':')
  const effort = rest.pop()
  const model = rest.join(':')
  return provider && model && effort ? { provider, model, effort } : null
}

function chooseWorker(fallback, mandatory, advice) {
  const jevChoice = advice?.available ? advice.worker?.choice : null
  const valid = workerRoles.has(jevChoice)
  const floorMet = !mandatory || (valid && rank[jevChoice] >= rank[mandatory])
  const accepted = Boolean(valid && floorMet)
  return {
    route: accepted ? { role: jevChoice, action: 'delegate', reason: 'jev' } : fallback,
    trace: {
      source: accepted ? 'jev' : 'deterministic-fallback',
      fallback: fallback.role,
      mandatoryFloor: mandatory,
      jev: { choice: jevChoice, confidence: advice?.worker?.confidence ?? null, accepted, reason: accepted ? 'validated-jev-choice' : (valid ? 'deterministic-role-floor' : 'missing-or-invalid-choice') }
    }
  }
}

function chooseTarget(route, requested, requestedRouteAuthorized, advice, env, mandatory, overrides) {
  const fallbackTarget = resolveRoleTarget(route.role, env)
  const fallback = { role: route.role, ...fallbackTarget }
  const decoded = decodeTarget(advice?.available ? advice.target?.choice : null)
  const validation = decoded ? validateModel(decoded) : { allowed: false, reason: 'missing-or-invalid-choice' }
  const jevAccepted = Boolean(decoded && validation.allowed && eligibleForRole(route.role, validation.entry))
  const jevTarget = jevAccepted ? { role: route.role, ...decoded } : null
  let effective = jevTarget || fallback
  let source = jevAccepted ? 'jev' : 'deterministic-fallback'

  if (advice?.available && advice.target && !jevAccepted) {
    overrides.push({ field: 'jevTarget', requested: decoded || advice.target.choice, applied: fallback, reason: validation.reason || 'deterministic-capability-floor' })
  }

  let requestedTrace = null
  if (requested) {
    const candidate = { ...effective, ...requested }
    const candidateRole = candidate.role || route.role
    const valid = validateModel(candidate)
    const roleFloorMet = (!mandatory || rank[candidateRole] >= rank[mandatory]) && rank[candidateRole] >= rank[route.role]
    const capabilityMet = valid.allowed && eligibleForRole(candidateRole, valid.entry)
    const jevAuthoritative = jevAccepted && !requestedRouteAuthorized
    const accepted = Boolean(!jevAuthoritative && roleFloorMet && capabilityMet)
    requestedTrace = { accepted, authorized: Boolean(requestedRouteAuthorized), reason: accepted ? 'validated-authorized-host-request' : (jevAuthoritative ? 'jev-authoritative' : (valid.reason || (roleFloorMet ? 'deterministic-capability-floor' : 'deterministic-role-floor'))) }
    if (accepted) {
      effective = { ...candidate, role: candidateRole }
      source = 'requested-route'
    } else {
      overrides.push({ field: 'requestedRoute', requested, applied: effective, reason: requestedTrace.reason })
    }
  }

  const finalValidation = validateModel(effective)
  if (!finalValidation.allowed) {
    overrides.push({ field: 'target', requested: effective, applied: fallback, reason: 'verified-registry-required' })
    effective = fallback
    source = 'deterministic-fallback'
  }

  const execution = target => ({ ...target, configured: Boolean(target.model), executionMode: executionModeForProvider(target.provider) })
  return {
    recommended: execution(jevTarget || fallback),
    effective: execution(effective),
    trace: {
      source,
      fallback: execution(fallback),
      jev: { choice: advice?.target?.choice ?? null, confidence: advice?.target?.confidence ?? null, accepted: jevAccepted, reason: jevAccepted ? 'validated-jev-target' : (validation.reason || 'deterministic-capability-floor') },
      requested: requested ? { value: requested, ...requestedTrace } : null
    }
  }
}

function normalizeWorkstreams(input) {
  const values = Array.isArray(input.workstreams) ? input.workstreams.slice(0, 3) : []
  const workstreams = values.map((value, index) => ({
    id: String(value?.id || `workstream-${index + 1}`).slice(0, 80),
    task: String(value?.task || '').slice(0, 1000),
    files: [...new Set((Array.isArray(value?.files) ? value.files : []).map(String).filter(Boolean))].slice(0, 12),
    tests: [...new Set((Array.isArray(value?.tests) ? value.tests : []).map(String).filter(Boolean))].slice(0, 8),
    dependsOn: [...new Set((Array.isArray(value?.dependsOn) ? value.dependsOn : []).map(String).filter(Boolean))].slice(0, 3)
  })).filter(value => value.task)
  const owners = new Map(), conflicts = []
  for (const workstream of workstreams) {
    for (const file of workstream.files) {
      if (owners.has(file)) conflicts.push({ file, workstreams: [owners.get(file), workstream.id] })
      else owners.set(file, workstream.id)
    }
  }
  return { workstreams, conflicts, nonOverlapping: conflicts.length === 0 }
}

function parallelPlan(input, advice, env) {
  const threshold = number(env.JEV_PARALLEL_THRESHOLD, 0.50)
  const normalized = normalizeWorkstreams(input)
  const jevParallel = advice?.available && advice.parallelRequired?.probability >= threshold && ['independent', 'critical_path'].includes(advice?.parallelJustification?.choice)
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
    threshold,
    justification: suppliedParallel ? 'independent' : (advice?.parallelJustification?.choice || 'none'),
    workstreams: normalized.workstreams,
    conflicts: normalized.conflicts,
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
  if (!attempt.allowed) return { packet: initialPacket, route: { action: attempt.action, reason: attempt.reason }, delegation: null, advice: null }

  const fallback = deterministicRoute({ task: initialPacket.task, risk, rootCause: initialPacket.rootCause, attempts: (input.attempts || []).length })
  let advice = null
  if (options.useJev !== false) advice = await askRoutingJev(initialPacket, options)
  const mandatory = mandatoryRole(input, initialPacket)
  const worker = chooseWorker(fallback, mandatory, advice)
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
    parallel,
    planReuse: {
      routingPhaseId: input.routingPhaseId || null,
      routeOncePerPhase: true,
      instruction: 'Reuse this route for the current meaningful build phase. Route again only when risk, scope, causal evidence, or provider readiness materially changes.'
    }
  }
  return {
    packet,
    route: { ...route, ...target.effective, requested, routingDecision },
    delegation: target.effective.role ? createDelegation(target.effective.role, packet, policy) : null,
    advice,
    policy,
    review,
    routingDecision,
    commander: { mode: 'host', apiCommander: false }
  }
}
