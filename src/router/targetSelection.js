import { getModel, validateModel, eligibleForRole, modelCapability } from '../providers/catalog.js'
import { resolveRoleTarget } from '../execution/roleResolver.js'
import { executionModeForProvider } from '../policy/providerExecution.js'
import { routingModels } from './jev.js'
import { allowsFlash } from '../policy/quality.js'

const rank = { scout: 0, engineer: 1, deep_debugger: 2, reviewer: 2, exceptional: 3 }
const efforts = ['none', 'low', 'medium', 'high', 'xhigh', 'max']
const floor = { scout: 'low', engineer: 'low', deep_debugger: 'high', reviewer: 'medium', exceptional: 'xhigh' }
const threshold = value => Number.isFinite(Number(value)) ? Math.min(1, Math.max(.70, Number(value))) : .70
const confident = (value, min) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= 1
const key = model => `${model.provider}:${model.id}`
const execution = target => ({ ...target, configured: true, executionMode: executionModeForProvider(target.provider) })
const decode = choice => {
  if (typeof choice !== 'string') return null
  const parts = choice.split(':')
  return parts.length === 2 || parts.length === 3 ? { provider: parts[0], model: parts[1], effort: parts[2] } : null
}
// Map an independent task-depth answer upward to a supported effort, never below
// the role floor. Effort uncertainty must not discard a sound lane/model choice.
function supportedEffort(model, role, desired) {
  if(model.provider==='openai')return model.id==='gpt-5.6-luna'?'max':'xhigh'
  const minimum = Math.max(efforts.indexOf(floor[role]), efforts.indexOf(desired))
  return efforts.find((effort, index) => index >= minimum && model.efforts.includes(effort)) || model.efforts.at(-1)
}

export function chooseTarget(route, requested, requestedRouteAuthorized, advice, env, mandatory, overrides, context = {}) {
  const minimum = threshold(env.JEV_MIN_CONFIDENCE), laneMinimum = threshold(env.JEV_LANE_MIN_CONFIDENCE)
  const configured = resolveRoleTarget(route.role, env), validation = validateModel(configured)
  const configuredAllowed = validation.allowed && eligibleForRole(route.role, validation.entry)
  let fallback = { role: route.role, ...(configuredAllowed ? configured : resolveRoleTarget(route.role, {})) }
  if (!configuredAllowed) overrides.push({ field: 'configuredTarget', requested: configured, applied: fallback, reason: validation.reason || 'deterministic-capability-floor' })
  const models = routingModels(env, route.role, context)
  if (!models.some(model => key(model) === `${fallback.provider}:${fallback.model}`)) {
    const unavailable = fallback
    fallback = { role: route.role, ...resolveRoleTarget(route.role, {}) }
    overrides.push({ field: 'configuredTarget', requested: unavailable, applied: fallback, reason: 'provider-not-configured-or-paid-gate-disabled' })
  }
  fallback.effort = supportedEffort(getModel(fallback.provider, fallback.model), route.role, fallback.effort)

  const modern = advice?.available && (advice.laneAdvicePresent || advice.nativeTarget || advice.externalTarget)
  const laneAdvice = advice?.available ? advice.executionLane : null
  const laneAvailable = models.some(model => model.executionMode === laneAdvice?.choice)
  const laneAccepted = Boolean(modern && laneAvailable && confident(laneAdvice?.confidence, laneMinimum))
  const lane = laneAccepted ? laneAdvice.choice : executionModeForProvider(fallback.provider)
  let laneFallback = fallback
  if (lane !== executionModeForProvider(fallback.provider)) {
    const entry = models.filter(model => model.executionMode === lane).sort((a, b) => modelCapability(b)-modelCapability(a) || (a.inputPerMTok + a.outputPerMTok) - (b.inputPerMTok + b.outputPerMTok))[0]
    laneFallback = { role: route.role, provider: entry.provider, model: entry.id, effort: supportedEffort(entry, route.role, 'high') }
  }
  const targetAdvice = advice?.available ? (modern ? (lane === 'native_host' ? advice.nativeTarget : advice.externalTarget) : advice.target) : null
  const decoded = decode(targetAdvice?.choice), entry = decoded ? getModel(decoded.provider, decoded.model) : null
  const capable = entry && eligibleForRole(route.role, entry)
  const available = entry && models.some(model => key(model) === key(entry))
  const sameLane = !modern || (laneAccepted && entry?.executionMode === lane)
  const accepted = Boolean(capable && available && sameLane && confident(targetAdvice?.confidence, minimum))
  const reason = !entry ? 'missing-or-invalid-choice' : !capable ? 'deterministic-capability-floor' : !available ? 'provider-not-configured-or-paid-gate-disabled' : !sameLane ? 'execution-lane-not-qualified-or-mismatched' : !accepted ? 'insufficient-confidence' : 'validated-jev-target'
  let effective = accepted ? { role: route.role, provider: entry.provider, model: entry.id } : { ...laneFallback }
  const effortChoice = (accepted && decoded?.effort) || advice?.effort?.choice
  const effortConfidence = accepted && decoded?.effort ? targetAdvice?.confidence : advice?.effort?.confidence
  const effortAccepted = Boolean((accepted || laneAccepted) && efforts.includes(effortChoice) && confident(effortConfidence, minimum))
  effective.effort = supportedEffort(getModel(effective.provider, effective.model), route.role, effortAccepted ? effortChoice : (effective.effort || 'high'))
  const recommended = execution(effective)
  let source = accepted ? 'jev' : laneAccepted ? 'jev-lane-deterministic-target' : 'deterministic-fallback'
  if (targetAdvice && !accepted) overrides.push({ field: 'jevTarget', requested: decoded || targetAdvice.choice, applied: recommended, reason })
  if ((accepted || laneAccepted) && (!effortAccepted || effective.effort !== effortChoice)) overrides.push({ field: 'jevEffort', requested: effortChoice || null, applied: effective.effort, reason: !effortAccepted ? 'effort-confidence-fallback' : 'supported-effort-and-role-floor' })

  let requestedTrace = null
  if (requested) {
    const candidate = { ...effective, ...requested }, candidateRole = candidate.role || route.role
    const candidateEntry = getModel(candidate.provider, candidate.model)
    if (candidateEntry && !Object.hasOwn(requested, 'effort') && Object.hasOwn(rank, candidateRole)) candidate.effort = supportedEffort(candidateEntry, candidateRole, candidate.provider==='openai'?resolveRoleTarget(candidateRole, {}).effort:'high')
    const valid = validateModel(candidate)
    const roleFloorMet = (mandatory === 'reviewer' ? candidateRole === 'reviewer' : (!mandatory || rank[candidateRole] >= rank[mandatory])) && rank[candidateRole] >= rank[route.role]
    const capabilityMet = valid.allowed && eligibleForRole(candidateRole, valid.entry) && (valid.entry.id!=='deepseek-flash'||allowsFlash(context))
    const jevAuthoritative = (accepted || laneAccepted) && !requestedRouteAuthorized
    const requestAccepted = Boolean(!jevAuthoritative && roleFloorMet && capabilityMet)
    requestedTrace = { accepted: requestAccepted, authorized: Boolean(requestedRouteAuthorized), reason: requestAccepted ? 'validated-host-request' : jevAuthoritative ? 'jev-authoritative' : valid.reason || (roleFloorMet ? 'deterministic-capability-floor' : 'deterministic-role-floor') }
    if (requestAccepted) {
      effective = { ...candidate, role: candidateRole, effort: supportedEffort(valid.entry, candidateRole, candidate.effort) }
      if (effective.effort !== candidate.effort) overrides.push({ field: 'requestedEffort', requested: candidate.effort, applied: effective.effort, reason: 'deterministic-effort-floor' })
      source = 'requested-route'
    } else overrides.push({ field: 'requestedRoute', requested, applied: effective, reason: requestedTrace.reason })
  }
  return {
    recommended, effective: execution(effective),
    trace: {
      source, fallback: execution(laneFallback),
      lane: { choice: laneAdvice?.choice || null, confidence: laneAdvice?.confidence ?? null, threshold: laneMinimum, accepted: laneAccepted, effective: executionModeForProvider(effective.provider), reason: laneAccepted ? 'validated-jev-lane' : modern ? (!laneAvailable ? 'lane-unavailable-or-invalid' : 'insufficient-confidence') : 'legacy-target-or-deterministic-fallback' },
      jev: { choice: targetAdvice?.choice ?? null, confidence: targetAdvice?.confidence ?? null, effort: effortChoice ?? null, effortConfidence: effortConfidence ?? null, effortAccepted, threshold: minimum, accepted, reason },
      requested: requested ? { value: requested, ...requestedTrace } : null
    }
  }
}
