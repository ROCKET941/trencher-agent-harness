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

function hasEscalationEvidence(packet) {
  return packet.risk === 'high' || Boolean(packet.rootCause) || packet.evidence.length > 0 || packet.files.length > 0 || packet.openQuestions.length > 0
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

export async function planTask(input, options = {}) {
  const env = options.env || process.env
  const classifiedRisk = classifyRisk(input.task).risk
  const risk = input.risk === 'high' || classifiedRisk === 'high' ? 'high' : (input.risk || classifiedRisk)
  const initialPacket = createEvidencePacket({ ...input, risk }, { contextProfile: 'normal' })
  const attempt = nextAttemptState({ attempts: input.attempts || [], newEvidence: Boolean(input.newEvidence) })
  if (!attempt.allowed) return { packet: initialPacket, route: { action: attempt.action, reason: attempt.reason }, delegation: null, advice: null }
  const fallback = deterministicRoute({ task: initialPacket.task, risk, rootCause: initialPacket.rootCause, attempts: (input.attempts || []).length })
  let route = fallback, advice = null
  if (options.useJev !== false) {
    advice = await askRoutingJev(initialPacket, options)
    const choice = advice.available && advice.worker?.confidence >= number(env.JEV_MIN_CONFIDENCE, 0.70) ? advice.worker.choice : null
    if (choice && rank[choice] >= rank[fallback.role] && (rank[choice] === rank[fallback.role] || hasEscalationEvidence(initialPacket))) route = { role: choice, action: 'delegate', reason: 'jev' }
  }
  const contextPolicy = applyAdvice(initialPacket, deterministicContext(initialPacket, route), advice, env)
  const packet = createEvidencePacket({ ...input, risk }, { contextProfile: contextPolicy.contextProfile })
  const reviewProbability = advice?.reviewRequired?.probability ?? 0
  const review = { required: risk === 'high', recommended: risk === 'high' || reviewProbability >= number(env.JEV_REVIEW_THRESHOLD, 0.70), reason: risk === 'high' ? 'deterministic-high-risk-policy' : (reviewProbability >= number(env.JEV_REVIEW_THRESHOLD, 0.70) ? 'jev' : 'not-required') }
  const policy = { ...contextPolicy, review }
  const fallbackTarget=route.role?resolveRoleTarget(route.role,env):null,requested=input.requestedRoute||null,overrides=[]
  let recommended={role:route.role,...fallbackTarget},effective={...recommended}
  if(advice?.target?.confidence>=number(env.JEV_MIN_CONFIDENCE,0.70)){
    const [provider,...rest]=advice.target.choice.split(':'),effort=rest.pop(),model=rest.join(':')
    const validity=validateModel({provider,model,effort});if(validity.allowed&&eligibleForRole(route.role,validity.entry))recommended={...recommended,provider,model,effort}
  }
  if(requested){const candidate={...effective,...requested},valid=validateModel(candidate);if(valid.allowed&&rank[candidate.role??route.role]>=rank[route.role]&&eligibleForRole(candidate.role??route.role,valid.entry))effective=candidate;else overrides.push({field:'requestedRoute',requested,applied:effective,reason:valid.reason||'deterministic-capability-floor'})}
  if(validateModel(effective).allowed===false){overrides.push({field:'target',requested:effective,applied:fallbackTarget,reason:'verified-registry-required'});effective={role:route.role,...fallbackTarget}}
  const recommendedValidity=validateModel(recommended)
  if(rank[recommended.role]>=rank[route.role]&&recommendedValidity.allowed&&eligibleForRole(route.role,recommendedValidity.entry))effective=requested?effective:recommended
  recommended={...recommended,executionMode:executionModeForProvider(recommended.provider)}
  effective={...effective,executionMode:executionModeForProvider(effective.provider)}
  const parallelRecommended=advice?.parallelRequired?.probability>=number(env.JEV_MIN_CONFIDENCE,0.70)&&['independent','critical_path'].includes(advice?.parallelJustification?.choice)?2:1
  const handoff=effective.executionMode==='native_host'?{required:true,mode:'native_host',billingSource:'chatgpt_plan',role:effective.role,provider:effective.provider,model:effective.model,effort:effective.effort}:null
  const routingDecision={requested,recommended,effective,overrides,handoff,parallel:{recommended:parallelRecommended,effective:Math.min(parallelRecommended,number(env.HARNESS_MAX_PARALLEL,1)),justification:advice?.parallelJustification?.choice||'none'}}
  return { packet, route:{...route,...effective,requested,routingDecision}, delegation: effective.role ? createDelegation(effective.role, packet, policy) : null, advice, policy, review, routingDecision,commander:{mode:'host',apiCommander:false} }
}
