import agents from '../../config/agents.json' with { type: 'json' }
export function getRole(role) { const config = agents.roles[role]; if (!config) throw new Error(`Unknown agent role: ${role}`); return structuredClone(config) }
export function createDelegation(role, packet, policy = {}) {
  const contextProfile = policy.contextProfile || packet.contextProfile || 'normal'
  const retrievalMode = policy.retrievalMode || 'adjacent'
  return {
    role,
    agent: getRole(role),
    context: { ...packet, contextProfile, retrievalMode },
    policy: { contextProfile, retrievalMode, expansionAllowed: Boolean(policy.expansionAllowed), review: policy.review || null },
    instruction: `Work only from the supplied bounded evidence. Context profile: ${contextProfile}. Retrieval mode: ${retrievalMode}. Do not claim authorization for protected actions and do not use shell, filesystem, deployment, network, or secret tools. You may only request bounded context or report a result. Return the schema: status, findings, artifact, evidence, tests, blockers, usage. Mark incomplete or blocked output honestly; never present a truncated patch as complete.`
  }
}
