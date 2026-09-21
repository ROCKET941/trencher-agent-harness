import agents from '../../config/agents.json' with { type: 'json' }
import { resolveRoleTarget } from '../execution/roleResolver.js'
import { COMMANDER } from '../policy/quality.js'
export function getRole(role) { const config = agents.roles[role]; if (!config) throw new Error(`Unknown agent role: ${role}`); return structuredClone(config) }
export function createDelegation(role, packet, policy = {}, target = null) {
  target ||= resolveRoleTarget(role,{})
  const contextProfile = policy.contextProfile || packet.contextProfile || 'normal'
  const retrievalMode = policy.retrievalMode || 'adjacent'
  const agent = getRole(role)
  if (target) {
    Object.assign(agent, {
      preferredFamily: target.executionMode === 'native_host' ? target.model.split('-').at(-1) : target.provider,
      reasoning: target.effort,
      provider: target.provider, model: target.model, effort: target.effort, executionMode: target.executionMode
    })
  }
  const toolScope = target?.executionMode === 'native_host'
    ? role==='scout' ? 'Research only: read, trace, run read-only diagnostics and report concise findings. Do not edit files, implement, perform final review, approve changes or commit.'
      : role==='reviewer' ? 'You are the one fresh read-only Astra XHigh final reviewer. Inspect the complete integrated diff and verification evidence for correctness, regressions, scope, architecture, security and test coverage. Return accepted=true or explicit blocking findings bound to the supplied artifact digest. Do not edit, apply patches or commit.'
      : 'Use host workspace tools only within the assigned scope as the permanent Astra XHigh commander. Apply or reject external candidate patches, integrate and run required checks. Prepare useful bounded coding assignments rather than reserving all implementation for yourself. Obtain one independent review through review_route and pass check_action(commit) before committing. Protected actions still require trusted owner authorization.'
    : role==='reviewer'
      ? 'You are the independent read-only cross-model reviewer. Do not use shell, filesystem, deployment, network, or secret tools. Inspect the supplied complete diff/source and verification evidence; challenge correctness, regressions and missing tests. Treat the author narrative as claims, not proof. Report only concrete findings with file/range and a reproducible failure or specific missing evidence; do not invent defects to appear critical. Do not write a patch or claim to run tests. You MUST CALL the provided report_result function (not a prose or JSON chat response). Include ALL required fields: status, findings, evidence, tests, blockers (each list may be empty), artifact:null, and review:{artifactDigest,accepted,coveredFiles}. Copy artifactDigest from context.reviewContext. Accept only if every changed file and relevant invariant is covered and blockers is empty. Otherwise report blocked/incomplete. Astra owns final signoff and real verification. Missing coverage requires a newly prepared review route, not a claimed acceptance.'
      : 'Do not use shell, filesystem, deployment, network, or secret tools. You may only request specific missing bounded context or report a result; paths alone do not provide file contents. You may produce a complete candidate implementation patch for your bounded workstream. Return patches as artifacts for Astra to apply and verify. You cannot edit the repository, approve final acceptance or commit.'
  return {
    role,
    agent,
    context: { ...packet, contextProfile, retrievalMode, taskKind:policy.taskKind||null },
    policy: { contextProfile, retrievalMode, taskKind:policy.taskKind||null, readOnly:role==='scout'||role==='reviewer', mayCommit:false, commander:{...COMMANDER}, commitGate:policy.commitGate||{required:true,tool:'check_action',action:'commit'}, expansionAllowed: Boolean(policy.expansionAllowed), review: policy.review || null },
    instruction: `Work from the supplied bounded evidence first. Context profile: ${contextProfile}. Retrieval mode: ${retrievalMode}. Do not broaden repository exploration unless this assigned retrieval mode and context profile permit it. Do not repeat discovery already captured in facts or inspected pointers. Do not claim authorization for protected actions. ${toolScope} Return compact findings, changed files or artifact, tests, blockers, and any exact missing evidence. Mark incomplete or blocked output honestly; never present a truncated patch as complete.`
  }
}
