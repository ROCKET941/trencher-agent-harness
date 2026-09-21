import { COMMANDER, FINAL_REVIEWER } from './quality.js'

const CHECKS=['tests','build','typecheck','lint']
export const ARTIFACT_DIGEST=/^[a-f0-9]{64}$/
export const requiredVerification = () => [...CHECKS]

// MCP cannot inspect a native host's Git worktree or authenticate subagent turns.
// These are explicit host attestations, pinned to a server-owned review route;
// the host must also enforce the returned denial before invoking Git.
export function checkCommit(input, reviewPlan) {
  const deny=reason=>({allowed:false,reason,evidenceSource:'host-attested',hostMustEnforce:true})
  if(!reviewPlan||reviewPlan.route?.role!=='reviewer')return deny('commit-requires-pinned-final-review')
  const target=reviewPlan.routingDecision?.effective,context=reviewPlan.routingDecision?.reviewContext
  if(target?.provider!==FINAL_REVIEWER.provider||target?.model!==FINAL_REVIEWER.model||target?.effort!==FINAL_REVIEWER.effort||target?.executionMode!=='native_host')return deny('commit-requires-astra-xhigh-review')
  if(!ARTIFACT_DIGEST.test(input?.artifactDigest||'')||context?.artifactDigest!==input.artifactDigest)return deny('commit-artifact-digest-mismatch')
  if(input.commander?.provider!==COMMANDER.provider||input.commander?.model!==COMMANDER.model||input.commander?.effort!==COMMANDER.effort||input.commander?.agentId!==context?.commanderAgentId)return deny('commit-requires-astra-xhigh-commander')
  const review=input.review
  if(!review?.agentId||review.agentId===context?.commanderAgentId||review.fresh!==true||review.readOnly!==true||review.provider!==FINAL_REVIEWER.provider||review.model!==FINAL_REVIEWER.model||review.effort!==FINAL_REVIEWER.effort)return deny('commit-requires-fresh-independent-reviewer')
  if(review.artifactDigest!==input.artifactDigest)return deny('commit-review-is-stale')
  if(review.accepted!==true||!Array.isArray(review.blockers)||review.blockers.length)return deny('commit-review-not-accepted')
  const verification=input.verification
  if(verification?.artifactDigest!==input.artifactDigest||verification.scopeVerified!==true)return deny('commit-verification-is-stale-or-scope-unverified')
  const checks=verification.checks
  if(!Array.isArray(checks)||checks.length!==CHECKS.length||new Set(checks.map(check=>check.name)).size!==CHECKS.length)return deny('commit-required-verification-missing')
  if(!CHECKS.every(name=>checks.some(check=>check.name===name&&typeof check.evidence==='string'&&check.evidence.trim()&&(check.status==='passed'||(name!=='tests'&&check.status==='not_applicable'&&typeof check.reason==='string'&&check.reason.trim())))))return deny('commit-required-verification-not-passed')
  return{allowed:true,reason:'astra-final-acceptance-and-verification-passed',artifactDigest:input.artifactDigest,reviewDecisionId:reviewPlan.routingDecision.decisionId,evidenceSource:'host-attested',hostMustEnforce:true}
}
