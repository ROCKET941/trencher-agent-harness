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
    instruction: `Work from the supplied bounded evidence first. Context profile: ${contextProfile}. Retrieval mode: ${retrievalMode}. Do not broaden repository exploration unless this retrieval mode and context profile permit it. Return compact findings, changed files, tests, and specific missing evidence required for further expansion.`
  }
}
