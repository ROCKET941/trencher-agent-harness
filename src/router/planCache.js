// Single-owner MCP process cache, shared across HTTP transports. No credentials,
// transcripts or filesystem reads. A restart/expiry requires an explicit new route.
export class PlanCache {
  #entries = new Map()
  constructor({ maxEntries = 128, ttlMs = 30 * 60 * 1000, now = Date.now } = {}) {
    this.maxEntries = maxEntries
    this.ttlMs = ttlMs
    this.now = now
  }
  remember(plan) {
    if (!plan.delegation) return plan
    const id = plan.routingDecision.decisionId
    const expiresAt = this.now() + this.ttlMs
    const saved = structuredClone(plan)
    saved.routingDecision.planReuse = { ...saved.routingDecision.planReuse, executionByDecisionId: true, expiresAt: new Date(expiresAt).toISOString() }
    saved.route.routingDecision = saved.routingDecision
    this.#entries.delete(id)
    this.#entries.set(id, { plan: saved, expiresAt })
    while (this.#entries.size > this.maxEntries) this.#entries.delete(this.#entries.keys().next().value)
    return structuredClone(saved)
  }
  get(id) {
    const saved = this.#entries.get(id)
    if (!saved) return null
    if (saved.expiresAt <= this.now()) { this.#entries.delete(id); return null }
    return structuredClone(saved.plan)
  }
}
export const planCache = new PlanCache()
