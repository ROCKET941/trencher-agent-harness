import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { planTask } from '../src/orchestrator.js'
import { createEvidencePacket } from '../src/context/evidencePacket.js'
import { authorizeAction } from '../src/policy/safety.js'
import { nextAttemptState } from '../src/policy/antiLoop.js'
import { executeRoutedTask } from '../src/mcp/tools-v04.js'
import { reviewRoute, checkAction } from '../src/mcp/tools.js'
import { AccountingStore } from '../src/execution/accountingStore.js'
import { ApprovalStore } from '../src/policy/approvalStore.js'
import { PlanCache } from '../src/router/planCache.js'
import { routingModels } from '../src/router/jev.js'
import { atLeast, boundedAt, gradeProviderTask, summarize } from '../benchmark/grading.js'
import { verifyClampPatch } from '../benchmark/git-fixture.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const cases = JSON.parse(await readFile(path.join(root, 'benchmark', 'cases.json'), 'utf8'))
const live = process.argv.includes('--live')
const endpoint = process.env.HARNESS_BENCHMARK_URL || 'http://127.0.0.1:18788/mcp'
const token = process.env.HARNESS_BENCHMARK_TOKEN || ''
const runId = process.env.HARNESS_BENCHMARK_RUN_ID || new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)
const profileRank = { tight: 0, normal: 1, expanded: 2 }
const retrievalRank = { exact: 0, adjacent: 1, exploratory: 2 }
const checks = []

function check(id, category, passed, expected, actual, points = 1) {
  checks.push({ id, category, passed: Boolean(passed), points, expected, actual })
}

async function deterministicChecks() {
  const exact = await planTask({ task: 'Find every caller of reconcileSwapFill.', files: ['src/swap/reconcile.ts'] }, { useJev: false })
  check('policy.route.exact.role', 'routing-policy', exact.route.role === 'scout', 'scout', exact.route.role, 2)
  check('policy.route.exact.context', 'routing-policy', exact.policy.contextProfile === 'tight' && exact.policy.retrievalMode === 'exact', 'tight/exact', `${exact.policy.contextProfile}/${exact.policy.retrievalMode}`, 2)
  check('policy.route.exact.luna', 'quality-gate', exact.route.model === 'gpt-5.6-luna' && exact.route.effort === 'max' && exact.delegation?.policy?.readOnly === true, 'Luna Max read-only', { model:exact.route.model, effort:exact.route.effort, readOnly:exact.delegation?.policy?.readOnly }, 3)

  const localized = await planTask({ task: 'Fix a localized stale quote.', rootCause: 'missing memo dependency', files: ['src/quote.ts'] }, { useJev: false })
  check('policy.route.localized.role', 'routing-policy', localized.route.role === 'engineer', 'engineer', localized.route.role, 2)
  check('policy.route.localized.context', 'routing-policy', localized.policy.contextProfile === 'tight' && localized.policy.retrievalMode === 'adjacent', 'tight/adjacent', `${localized.policy.contextProfile}/${localized.policy.retrievalMode}`, 2)
  check('policy.route.localized.commander-review', 'quality-gate', localized.route.model === 'gpt-6-astra' && localized.route.effort === 'xhigh' && localized.review?.required === true && localized.review?.reviewer?.count === 1, 'Astra XHigh commander plus one required reviewer', { route:localized.route, review:localized.review }, 4)

  const externalPool=routingModels({HARNESS_ENABLE_PAID_EXECUTION:'true',XAI_API_KEY:'benchmark',DEEPSEEK_API_KEY:'benchmark',KIMI_API_KEY:'benchmark'},'engineer',{...localized.packet,taskKind:'implementation'}).filter(model=>model.executionMode==='external_api').map(model=>`${model.provider}:${model.id}`)
  check('policy.external.quality-pool', 'quality-gate', JSON.stringify(externalPool)===JSON.stringify(['xai:grok-4.6','deepseek:deepseek-v4-pro','kimi:kimi-k3']), 'Grok 4.6, DeepSeek V4 Pro, Kimi K3; no Flash', externalPool, 4)

  const high = await planTask({ task: 'Diagnose production financial settlement concurrency failure.', risk: 'high' }, { useJev: false })
  check('policy.route.high.role', 'safety', high.route.role === 'deep_debugger', 'deep_debugger', high.route.role, 3)
  check('policy.route.high.context', 'safety', high.policy.contextProfile === 'expanded' && high.policy.retrievalMode === 'exploratory', 'expanded/exploratory', `${high.policy.contextProfile}/${high.policy.retrievalMode}`, 3)
  check('policy.route.high.review', 'safety', high.review.required === true, true, high.review, 3)

  for (const action of ['deploy', 'force_push', 'financial_execution', 'secret_read', 'wallet_permission_change']) {
    const result = authorizeAction(action, { explicitlyAuthorized: false })
    check(`policy.protected.${action}`, 'safety', result.allowed === false, false, result, 2)
  }
  const retryOverride = authorizeAction('retry_budget_override', { explicitlyAuthorized: true, authorizationSource: 'trusted_host' })
  check('policy.protected.retry-budget', 'safety', retryOverride.allowed === false, false, retryOverride, 3)
  const approvalEnv={HARNESS_ENABLE_TRUSTED_APPROVALS:'true'},approvalDirectory=await mkdtemp(path.join(os.tmpdir(),'benchmark-approval-')),approvalStore=new ApprovalStore({file:path.join(approvalDirectory,'approvals.json'),env:approvalEnv})
  const hostApproval=await approvalStore.issue({action:'deploy',scope:'benchmark:production:artifact',reason:'benchmark owner approval'}),approvalArgs={action:'deploy',approval:{id:hostApproval.id,scope:hostApproval.scope}}
  const allowedDeployment=await checkAction(approvalArgs,{env:approvalEnv,approvalStore}),replayedDeployment=await checkAction(approvalArgs,{env:approvalEnv,approvalStore})
  check('policy.protected.trusted-host-approval','safety',allowedDeployment.allowed===true&&allowedDeployment.oneTime===true&&replayedDeployment.reason==='trusted-host-approval-already-consumed','one scoped trusted-host approval succeeds exactly once',{allowed:allowedDeployment,replay:replayedDeployment},4)

  const withoutEvidence = nextAttemptState({ attempts: [{}], newEvidence: false })
  const twoStrikes = nextAttemptState({ attempts: [{}, {}], newEvidence: true })
  const authorizedFinal = nextAttemptState({ attempts: [{}, {}], newEvidence: true, ownerAuthorizedRetry: true, retryReason: 'new causal trace' })
  check('policy.retry.new-evidence', 'safety', withoutEvidence.allowed === false && withoutEvidence.reason === 'second-attempt-requires-new-evidence', 'blocked pending new evidence', withoutEvidence, 2)
  check('policy.retry.owner-gate', 'safety', twoStrikes.allowed === false && twoStrikes.reason === 'third-attempt-requires-owner-authorization', 'owner authorization required', twoStrikes, 3)
  check('policy.retry.final', 'safety', authorizedFinal.allowed === true && authorizedFinal.finalAttempt === true, 'authorized final attempt', authorizedFinal, 3)

  const huge = 'a'.repeat(9000)
  const packet = createEvidencePacket({ task: huge, evidence: Array.from({ length: 12 }, (_, index) => `${index}:${huge}`), files: Array.from({ length: 10 }, (_, index) => `src/file-${index}.js`) }, { contextProfile: 'tight' })
  check('policy.context.counts', 'context-control', packet.evidence.length === 5 && packet.files.length === 3, '5 evidence / 3 files', `${packet.evidence.length} evidence / ${packet.files.length} files`, 2)
  check('policy.context.sizes', 'context-control', packet.task.length <= 4000 && packet.evidence.every(value => value.length <= 3000), 'task <=4000 and evidence <=3000 chars', { task: packet.task.length, evidence: packet.evidence.map(value => value.length) }, 2)
  check('policy.context.truncation', 'context-control', packet.truncation.occurred && packet.truncation.truncatedFields.length > 0 && packet.truncation.dropped.evidence === 7, 'explicit truncation and dropped counts', packet.truncation, 2)

  const native = await executeRoutedTask({ task: 'Implement a localized UI fix.', rootCause: 'stale memo dependency', requestedRoute: { role: 'engineer', provider: 'openai', model: 'gpt-6-astra', effort: 'xhigh' } }, { useJev: false, env: {} })
  check('policy.native.no-api', 'native-boundary', native.reason === 'native-host-agent-required' && native.execution === null, 'native handoff with no API execution', { reason: native.reason, execution: native.execution }, 4)
  check('policy.native.billing', 'native-boundary', native.handoff?.billingSource === 'chatgpt_plan' && native.target?.executionMode === 'native_host', 'chatgpt_plan/native_host', { handoff: native.handoff, target: native.target }, 4)
  check('policy.native.commander', 'native-boundary', native.handoff?.scope === 'commander' && native.handoff?.parentModelUnchanged === true, 'Astra commander / parent unchanged', native.handoff, 4)

  const choice=(value,confidence)=>({type:'choice',choice:value,confidence,probabilities:{[value]:1}}),noul=value=>({type:'noul',noul:value})
  const jevFetch=async()=>({ok:true,status:200,headers:{get:()=>null},json:async()=>({model:'benchmark-jev',answers:{worker:choice('engineer',.25),target:choice('openai:gpt-6-astra:xhigh',.2),context_profile:choice('tight',.9),retrieval_mode:choice('adjacent',.9),expand_context:noul(0),parallel_required:noul(.9),parallel_justification:choice('independent',.9),review_required:noul(0)},usage:{}})})
  const jevEnv={TYPESAFE_API_KEY:'benchmark',HARNESS_ENABLE_PAID_EXECUTION:'true',HARNESS_JEV_CALL_COST_USD:'.01',JEV_MIN_CONFIDENCE:'.70',HARNESS_MAX_PARALLEL:'3'}
  const jevPlan=await planTask({task:'Implement three independent bounded modules.',files:['src/a.js','src/b.js','src/c.js']},{env:jevEnv,store:new AccountingStore(),fetchImpl:jevFetch,useCache:false})
  check('policy.jev.low-confidence-target', 'routing-policy', jevPlan.route.model === 'gpt-6-astra' && jevPlan.route.effort === 'xhigh' && jevPlan.routingDecision.selection.target.source === 'deterministic-fallback' && jevPlan.routingDecision.selection.target.jev.reason === 'insufficient-confidence', 'transparent Astra XHigh fallback', jevPlan.routingDecision.selection.target, 4)
  check('policy.jev.parallel-handoff', 'routing-policy', jevPlan.routingDecision.parallel.effective === 3 && jevPlan.routingDecision.handoff?.orchestration?.strategy === 'commander' && jevPlan.routingDecision.handoff?.orchestration?.maxAgents === 1, 'parallel work advice retained with one Astra commander', {parallel:jevPlan.routingDecision.parallel,handoff:jevPlan.routingDecision.handoff}, 4)
  const apiCommander = await executeRoutedTask({ task: 'Implement a localized fix.', commanderMode: 'api' }, { useJev: false, env: {} })
  check('policy.api-commander', 'native-boundary', apiCommander.reason === 'api-commander-disabled-native-host-policy' && apiCommander.execution === null, 'API commander fails closed', apiCommander, 4)

  const planCache=new PlanCache(),artifactDigest='a'.repeat(64),review=await reviewRoute({task:'Review the complete integrated benchmark change.',rootCause:'implementation-complete',reviewContext:{artifactDigest,commanderAgentId:'benchmark-commander'}},{useJev:false,env:{},planCache})
  const commit={reviewDecisionId:review.routingDecision.decisionId,artifactDigest,commander:{agentId:'benchmark-commander',provider:'openai',model:'gpt-6-astra',effort:'xhigh'},review:{agentId:'benchmark-reviewer',provider:'openai',model:'gpt-6-astra',effort:'xhigh',artifactDigest,fresh:true,readOnly:true,accepted:true,blockers:[]},verification:{artifactDigest,scopeVerified:true,checks:['tests','build','typecheck','lint'].map(name=>({name,status:'passed',evidence:`benchmark ${name} passed`}))}}
  const approved=await checkAction({action:'commit',commit},{planCache}),stale=structuredClone(commit);stale.review.artifactDigest='b'.repeat(64)
  const staleResult=await checkAction({action:'commit',commit:stale},{planCache})
  check('policy.review.fixed-astra', 'quality-gate', review.route.model === 'gpt-6-astra' && review.route.effort === 'xhigh' && review.delegation?.policy?.readOnly === true && review.routingDecision?.handoff?.orchestration?.maxAgents === 1, 'one read-only Astra XHigh reviewer', {route:review.route,handoff:review.routingDecision?.handoff}, 4)
  check('policy.commit-gate', 'quality-gate', approved.allowed === true && staleResult.allowed === false, 'matching acceptance allowed; stale acceptance denied', {approved,stale:staleResult}, 5)
}

let session = null
let rpcId = 1
async function rpc(method, params = {}) {
  const headers = { accept: 'application/json, text/event-stream', 'content-type': 'application/json' }
  if (session) headers['mcp-session-id'] = session
  if (token) headers.authorization = `Bearer ${token}`
  const started = performance.now()
  const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }) })
  const body = await response.text()
  assert.ok(response.ok, `MCP HTTP ${response.status}: ${body}`)
  session = response.headers.get('mcp-session-id') || session
  const raw = response.headers.get('content-type')?.includes('text/event-stream')
    ? body.split('\n').find(line => line.startsWith('data: '))?.slice(6)
    : body
  return { value: raw ? JSON.parse(raw) : null, latencyMs: Math.round(performance.now() - started) }
}

async function initializeMcp() {
  const initialized = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'trencher-benchmark', version: cases.version } })
  const headers = { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...(session ? { 'mcp-session-id': session } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }
  await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) })
  return initialized
}

async function tool(name, args) {
  const result = await rpc('tools/call', { name, arguments: args })
  const text = result.value?.result?.content?.find(item => item.type === 'text')?.text
  return { data: text ? JSON.parse(text) : null, latencyMs: result.latencyMs }
}

async function liveChecks() {
  const jevRoutes = []
  const initialized = await initializeMcp()
  check('live.mcp.initialize', 'mcp', initialized.value?.result?.serverInfo?.name === 'trencher-agent-harness', 'trencher-agent-harness', initialized.value?.result?.serverInfo, 3)
  const listed = await rpc('tools/list')
  const toolNames = listed.value?.result?.tools?.map(item => item.name) || []
  for (const name of ['route_task', 'execute_routed_task', 'provider_readiness', 'provider_status', 'model_catalog', 'check_action']) check(`live.mcp.tool.${name}`, 'mcp', toolNames.includes(name), `tool ${name}`, toolNames, 1)

  const readiness=(await tool('provider_readiness',{refresh:false})).data,statuses=readiness?.statuses||{}
  check('live.native.status', 'native-boundary', statuses.openai?.ready === true && statuses.openai?.executionMode === 'native_host' && statuses.openai?.keyEnv == null, 'ready native_host with no API key', statuses.openai, 4)
  for (const provider of ['xai', 'deepseek', 'kimi']) check(`live.provider.${provider}.configured`, 'provider-readiness', statuses[provider]?.ready === true, 'ready external provider', statuses[provider], 2)

  for (const item of cases.jevRouting) {
    const result = await tool('route_task', { ...item.input, useJev: true })
    const plan = result.data
    jevRoutes.push({ id: item.id, latencyMs: result.latencyMs, route: plan.route, policy: plan.policy, review: plan.review, advice: { available: plan.advice?.available, reason: plan.advice?.reason, model: plan.advice?.model, usage: plan.advice?.usage, costUsd: plan.advice?.job?.actualCostUsd ?? null, cacheHit: plan.advice?.cacheHit } })
    check(`jev.${item.id}.available`, 'jev-routing', plan.advice?.available === true && plan.advice?.reason === 'jev', 'Jev available', { available: plan.advice?.available, reason: plan.advice?.reason, model: plan.advice?.model }, 2)
    check(`jev.${item.id}.role`, 'jev-routing', item.expect.roles.includes(plan.route?.role), item.expect.roles, plan.route?.role, 2)
    if (item.expect.maxContextProfile) check(`jev.${item.id}.context-max`, 'jev-routing', boundedAt(plan.policy?.contextProfile, item.expect.maxContextProfile, profileRank), `<=${item.expect.maxContextProfile}`, plan.policy?.contextProfile, 2)
    if (item.expect.minContextProfile) check(`jev.${item.id}.context-min`, 'jev-routing', atLeast(plan.policy?.contextProfile, item.expect.minContextProfile, profileRank), `>=${item.expect.minContextProfile}`, plan.policy?.contextProfile, 2)
    if (item.expect.maxRetrievalMode) check(`jev.${item.id}.retrieval-max`, 'jev-routing', boundedAt(plan.policy?.retrievalMode, item.expect.maxRetrievalMode, retrievalRank), `<=${item.expect.maxRetrievalMode}`, plan.policy?.retrievalMode, 2)
    if (item.expect.minRetrievalMode) check(`jev.${item.id}.retrieval-min`, 'jev-routing', atLeast(plan.policy?.retrievalMode, item.expect.minRetrievalMode, retrievalRank), `>=${item.expect.minRetrievalMode}`, plan.policy?.retrievalMode, 2)
    if (item.expect.reviewRequired) check(`jev.${item.id}.review`, 'jev-routing', plan.review?.required === true, true, plan.review, 3)
  }

  const native = await tool('execute_routed_task', { task: 'Benchmark native handoff for a bounded implementation.', rootCause: 'known localized defect', requestedRoute: { role: 'engineer', provider: 'openai', model: 'gpt-6-astra', effort: 'xhigh' } })
  check('live.native.execution-boundary', 'native-boundary', native.data?.reason === 'native-host-agent-required' && native.data?.execution === null && native.data?.handoff?.billingSource === 'chatgpt_plan', 'native handoff, no API execution', native.data, 5)

  const targets = [
    { name: 'Grok 4.6', provider: 'xai', model: 'grok-4.6', effort: 'high' },
    { name: 'DeepSeek V4 Pro', provider: 'deepseek', model: 'deepseek-v4-pro', effort: 'high' },
    { name: 'Kimi K3', provider: 'kimi', model: 'kimi-k3', effort: 'high' }
  ]
  const executions = []
  for (const target of targets) {
    for (const taskCase of cases.providerTasks) {
      const uniqueTask = `${taskCase.task}\nBenchmark identity: ${cases.version}/${runId}/${target.provider}/${taskCase.id}.`
      const run = await tool('execute_routed_task', {
        task: uniqueTask,
        rootCause: taskCase.rootCause,
        files: taskCase.files,
        tests: taskCase.tests,
        evidence: taskCase.evidence,
        requestedRoute: { provider: target.provider, model: target.model, effort: target.effort },
        requestedRouteAuthorized: true,
        idempotencyKey: `benchmark-${cases.version}-${runId}-${target.provider}-${taskCase.id}`,
        deadlineMs: 90000,
        budget: { maxInputTokens: 3500, maxEstimatedInputTokens: 3500, maxOutputTokens: 1500, maxDelegations: 1 }
      })
      const execution = run.data?.execution
      const structured = execution?.result?.structured
      const grade = gradeProviderTask(taskCase.kind, structured)
      const git = taskCase.kind === 'clamp_patch' ? await verifyClampPatch(structured) : null
      const row = {
        provider: target.provider, model: target.model, task: taskCase.id, latencyMs: run.latencyMs,
        executed: execution?.executed === true, completion: execution?.result?.completion || null,
        contractStatus: structured?.status || null, accuracy: grade, git,
        usage: execution?.result?.usage || null, costUsd: execution?.job?.actualCostUsd ?? null,
        estimatedInputTokens: execution?.preflight?.estimatedInputTokens ?? null,
        artifact: structured?.artifact ?? null, reason: run.data?.reason || execution?.reason || null,
        route: { role: run.data?.plan?.route?.role, contextProfile: run.data?.plan?.policy?.contextProfile, retrievalMode: run.data?.plan?.policy?.retrievalMode },
        jev: { available: run.data?.plan?.advice?.available, reason: run.data?.plan?.advice?.reason, model: run.data?.plan?.advice?.model, usage: run.data?.plan?.advice?.usage, costUsd: run.data?.plan?.advice?.job?.actualCostUsd ?? null, cacheHit: run.data?.plan?.advice?.cacheHit }
      }
      executions.push(row)
      const prefix = `provider.${target.provider}.${taskCase.id}`
      check(`${prefix}.executed`, 'provider-contract', row.executed, true, { reason: row.reason, completion: row.completion }, 2)
      check(`${prefix}.contract`, 'provider-contract', row.completion?.status === 'complete' && row.contractStatus === 'complete', 'complete report_result', { completion: row.completion, contractStatus: row.contractStatus }, 2)
      check(`${prefix}.accuracy`, 'provider-accuracy', grade.all, true, grade.detail, 4)
      check(`${prefix}.input-bound`, 'context-control', Number.isFinite(row.estimatedInputTokens) && row.estimatedInputTokens <= 3500, '<=3500 estimated input tokens', row.estimatedInputTokens, 1)
      if (git) check(`${prefix}.git-build`, 'git-build', git.passed, 'git apply --check, apply, and 3 passing tests', git, 3)
    }
  }
  return { initialized: initialized.value?.result?.serverInfo, statuses, jevRoutes, executions }
}

await deterministicChecks()
const liveData = live ? await liveChecks() : null
const score = summarize(checks)
const result = {
  benchmark: 'trencher-harness-acceptance', version: cases.version, runId, mode: live ? 'live' : 'deterministic',
  generatedAt: new Date().toISOString(), endpoint: live ? endpoint : null, score, checks, live: liveData
}
const output = process.env.HARNESS_BENCHMARK_OUTPUT
if (output) { const resolved = path.resolve(output); await mkdir(path.dirname(resolved), { recursive: true }); await writeFile(resolved, `${JSON.stringify(result, null, 2)}\n`) }
console.log(JSON.stringify(result, null, 2))
if (checks.some(item => !item.passed)) process.exitCode = 1
