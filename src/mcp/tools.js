import { planTask } from '../orchestrator.js'
import { createEvidencePacket } from '../context/evidencePacket.js'
import { createTaskLedger } from '../context/taskLedger.js'
import { nextAttemptState } from '../policy/antiLoop.js'
import { authorizeAction } from '../policy/safety.js'
import { createDelegation } from '../providers/registry.js'
import { planCache } from '../router/planCache.js'

export async function routeTask(input, options = {}) {
  return (options.planCache || planCache).remember(await planTask(input, options))
}

export function buildEvidencePacket(input = {}) {
  const packet = createEvidencePacket(input)
  return { packet, ledger: createTaskLedger(packet) }
}

export function checkContinue(input = {}) {
  return nextAttemptState({
    attempts: Array.isArray(input.attempts) ? input.attempts : [],
    newEvidence: Boolean(input.newEvidence),
    ownerAuthorizedRetry: Boolean(input.ownerAuthorizedRetry),
    retryReason: input.retryReason
  })
}

export function checkAction(input = {}) {
  return authorizeAction(String(input.action || ''), {
    explicitlyAuthorized: Boolean(input.explicitlyAuthorized)
  })
}

export function createDelegationRequest(input = {}) {
  if (!input.role) throw new Error('role is required')
  return createDelegation(input.role, createEvidencePacket(input.packet || {}))
}

export async function reviewRoute(input = {}, options = {}) {
  return routeTask({
    ...input,
    task: input.task || 'Review a completed engineering change',
    risk: input.risk || 'normal',
    evidence: input.evidence || [],
    files: input.files || [],
    tests: input.tests || [],
    protectedBoundaries: input.protectedBoundaries || [],
    rootCause: input.rootCause || 'implementation-complete'
  }, { ...options, review: true })
}
