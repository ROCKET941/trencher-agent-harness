import { classifyRisk } from '../router/risk.js'

export const COMMANDER = Object.freeze({ mode:'host', apiCommander:false, provider:'openai', model:'gpt-6-astra', effort:'xhigh', executionMode:'native_host', billingSource:'chatgpt_plan' })
export const FINAL_REVIEWER = Object.freeze({ provider:'openai', model:'gpt-6-astra', effort:'xhigh', executionMode:'native_host', billingSource:'chatgpt_plan', fresh:true, readOnly:true, count:1 })

// Task labels may narrow a low-risk envelope, never relax a safety floor.
// Ambiguous work defaults to implementation; a search verb embedded in a build
// request must not give a research-only worker write ownership.
const MUTATION = /\b(implement|build|fix|patch|edit|change|update|add|remove|delete|replace|refactor|migrate|commit|deploy|write|rewrite)\b/i
const RESEARCH = /^\s*(find|locate|search|trace|list|read|inspect|investigate|research|summarize|identify|where\s+is|which|explain|analyze|diagnose|reproduce)\b/i
export function taskKind(packet = {}, requested) {
  const task=String(packet.task||'')
  if(requested==='mechanical'&&packet.risk!=='high'&&classifyRisk(task).risk!=='high'&&packet.rootCause&&packet.evidence?.length&&packet.files?.length===1&&!packet.openQuestions?.length)return'mechanical'
  if(!MUTATION.test(task)&&(requested==='research'||RESEARCH.test(task)))return'research'
  return'implementation'
}
const canonicalSourcePath=value=>String(value||'').replaceAll('\\','/').replace(/\/+/g,'/').replace(/^\.\//,'').toLowerCase()
export function flashSourcePaths(context={}) {
  const approved=context.approvedEvidence||{}
  return[...new Set([
    ...(context.files||[]),...(context.inspected||[]).map(value=>value?.path),
    ...(approved.files||[]),...(approved.inspected||[]).map(value=>value?.path)
  ].map(canonicalSourcePath).filter(Boolean))]
}
export const allowsFlash = context => context?.taskKind==='mechanical' && context?.risk!=='high' && flashSourcePaths(context).length===1
export function reviewPolicy(kind,risk,probability=0) {
  const required=kind!=='research'||risk==='high'
  return{required,recommended:required,reason:required?'mandatory-astra-final-acceptance':'read-only-research',probability,reviewer:{...FINAL_REVIEWER},scope:'complete-integrated-diff',before:'commit',hostEnforced:true}
}
