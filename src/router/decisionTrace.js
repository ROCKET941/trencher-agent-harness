import { createHash } from 'node:crypto'
import routing from '../../config/routing.json' with { type: 'json' }
import { REGISTRY_VERSION } from '../providers/catalog.js'

// Sort object keys recursively; array order remains meaningful evidence order.
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
const digest = value => createHash('sha256').update(canonical(value)).digest('hex')

export function withDecisionTrace(plan) {
  const decision = plan.routingDecision || {}
  const { routingDecision: _nestedDecision, ...route } = plan.route || {}
  const evidenceDigest = digest(plan.packet || {})
  // Exclude call IDs, timestamps, cache state, usage, and raw Jev responses.
  const payloadDigest = digest({
    version: 1, policyVersion: routing.version, registryVersion: REGISTRY_VERSION,
    evidenceDigest, route, policy: plan.policy || null,
    requested: decision.requested || null, recommended: decision.recommended || null,
    effective: decision.effective || null, selection: decision.selection || null,
    overrides: decision.overrides || [], parallel: decision.parallel || null,
    routingPhaseId: decision.planReuse?.routingPhaseId || null
  })
  const routingDecision = { ...decision, decisionId: `route_${payloadDigest.slice(0, 32)}`, payloadDigest, evidenceDigest }
  return { ...plan, routingDecision, route: { ...route, routingDecision } }
}
