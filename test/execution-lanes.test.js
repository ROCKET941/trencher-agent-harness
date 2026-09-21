import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { planTask } from '../src/orchestrator.js'
import { normalizeExecutionLane } from '../src/router/jev.js'
import { PlanCache } from '../src/router/planCache.js'
import { routeTask, reviewRoute } from '../src/mcp/tools.js'
import { executeRoutedTask, providerReadiness } from '../src/mcp/tools-v04.js'
import { AccountingStore } from '../src/execution/accountingStore.js'
import { registerProvider, clearProviders } from '../src/providers/registry-v12.js'
import { normalizeResult } from '../src/providers/base.js'
import { createServer } from '../src/mcp/server.js'
import { InMemoryTransport } from '@modelcontextprotocol/server'

const choice = (choice, confidence = .91) => ({ type: 'choice', choice, confidence })
const answers = (target = 'deepseek:deepseek-v4-pro', confidence = .91) => ({ worker: choice('engineer'), execution_lane: choice('external_api'), external_target: choice(target, confidence), native_target: choice('openai:gpt-5.6-luna'), effort: choice('high', .2), review_required: { type: 'noul', noul: .9 } })
const input = { task: 'Analyze the supplied clamp helper and return a bounded patch', risk: 'normal', rootCause: 'Math.min uses the lower bound', evidence: ['function clamp(v, lo, hi) { return Math.min(lo, Math.max(lo, v)); }'], files: ['src/clamp.js'] }
const report = { name: 'report_result', arguments: JSON.stringify({ status: 'complete', findings: ['Use hi in Math.min'], artifact: null, evidence: ['supplied helper'], tests: ['mock'], blockers: [] }) }
async function fixture(response = answers(), extraEnv = {}) {
  const env = { TYPESAFE_API_KEY: 'mock-jev', XAI_API_KEY: 'mock-xai', DEEPSEEK_API_KEY: 'mock-deepseek', KIMI_API_KEY: 'mock-kimi', HARNESS_ENABLE_PAID_EXECUTION: 'true', HARNESS_JEV_CALL_COST_USD: '.01', ...extraEnv }
  const store = new AccountingStore({ file: path.join(await mkdtemp(path.join(os.tmpdir(), 'execution-lanes-')), 'ledger.json'), env })
  const calls = [], options = { env, store, planCache: new PlanCache(), useCache: false, fetchImpl: async (_url, request) => { calls.push(JSON.parse(request.body)); return { ok: true, json: async () => ({ model: 'jev-mock', answers: response, usage: { input_tokens: 10 } }) } } }
  return { options, calls }
}
function adapter(provider, calls) {
  return { execute: async request => { calls.push(request); return normalizeResult({ provider, model: request.model, role: request.role, usage: { inputTokens: 12, outputTokens: 5 }, metadata: { toolCalls: [report] } }) } }
}

test('execution-lane normalization is typed and rejects unknown lanes', () => {
  for (const lane of ['native_host', 'external_api']) assert.equal(normalizeExecutionLane(choice(lane)).choice, lane)
  for (const value of [null, choice('api'), { type: 'noul', noul: 1 }]) assert.equal(normalizeExecutionLane(value), null)
})

test('Jev receives independent lane hypotheses and only configured eligible candidates in one call', async () => {
  const { options, calls } = await fixture(answers(), { XAI_API_KEY: '', KIMI_API_KEY: '' })
  const plan = await planTask(input, options), sent = calls[0]
  assert.equal(calls.length, 1)
  assert.deepEqual(Object.keys(sent.questions.external_target.criteria), ['deepseek:deepseek-v4-pro'])
  assert.match(sent.questions.native_target.instructions, /Independently/)
  assert.match(sent.questions.external_target.instructions, /Independently/)
  assert.match(sent.questions.effort.instructions, /Do not condition on any other answer/)
  assert.match(sent.questions.execution_lane.instructions, /file paths alone are not source content/)
  assert.equal(plan.advice.target.choice, 'deepseek:deepseek-v4-pro')
  assert.equal(plan.advice.reviewRequired.probability, .9)
  assert.equal(plan.review.recommended, true)
})

test('all three external providers survive uncertain effort and actually dispatch the selected model', async () => {
  for (const [provider, model] of [['deepseek', 'deepseek-v4-pro'], ['xai', 'grok-4.6'], ['kimi', 'kimi-k3']]) {
    const { options, calls } = await fixture(answers(`${provider}:${model}`)), executions = []
    clearProviders(); registerProvider(provider, adapter(provider, executions))
    const plan = await routeTask(input, options)
    assert.equal(plan.route.provider, provider); assert.equal(plan.route.model, model)
    assert.equal(plan.routingDecision.selection.target.lane.accepted, true)
    assert.equal(plan.routingDecision.selection.target.jev.effortAccepted, false)
    assert.equal(plan.routingDecision.dispatch.tool, 'execute_routed_task')
    assert.match(plan.delegation.instruction, /Do not use shell, filesystem/)
    assert.equal(plan.delegation.agent.model, model)
    assert.equal(plan.delegation.agent.preferredFamily, provider)
    assert.equal(plan.delegation.agent.reasoning, plan.route.effort)
    const executed = await executeRoutedTask({ decisionId: plan.routingDecision.decisionId }, options)
    assert.equal(calls.length, 1); assert.equal(executions.length, 1)
    assert.equal(executed.execution.executed, true); assert.equal(executions[0].model, model)
    assert.equal(executed.plan.routingDecision.decisionId, plan.routingDecision.decisionId)
    const replay = await executeRoutedTask({ decisionId: plan.routingDecision.decisionId }, options)
    assert.equal(replay.execution.reason, 'idempotent-replay'); assert.equal(executions.length, 1)
    const usage = await options.store.getUsage(executed.execution.taskId)
    assert.equal(usage.task.starts, 1); assert.equal(usage.task.auxiliaryStarts, 1)
    assert.equal(usage.task.inputTokens, 22)
  }
})

test('confident external lane retains strongest-capability external fallback with uncertain model and effort', async () => {
  const { options } = await fixture(answers('kimi:kimi-k3', .25))
  const plan = await planTask(input, options)
  assert.equal(plan.route.provider, 'deepseek'); assert.equal(plan.route.model, 'deepseek-v4-pro')
  assert.equal(plan.route.effort, 'high') // quality-first external default
  assert.equal(plan.routingDecision.selection.target.source, 'jev-lane-deterministic-target')
  assert.equal(plan.routingDecision.selection.target.jev.accepted, false)
})

test('confident task effort applies even when the model falls back within the accepted lane', async () => {
  const { options } = await fixture({ ...answers('kimi:kimi-k3', .25), effort: choice('max') })
  const plan = await planTask(input, options)
  assert.equal(plan.route.model, 'deepseek-v4-pro'); assert.equal(plan.route.effort, 'max')
  assert.equal(plan.routingDecision.selection.target.jev.effortAccepted, true)
})

test('unavailable, invalid or low-confidence lane cannot be bypassed by confident model advice', async () => {
  for (const lane of [choice('external_api', .4), choice('external_api', 1.1), choice('external_api', true), choice('external_api', '1'), choice('invented'), null]) {
    const { options } = await fixture({ ...answers(), execution_lane: lane }, { JEV_LANE_MIN_CONFIDENCE: '.2' })
    const plan = await planTask(input, options)
    assert.equal(plan.route.provider, 'openai'); assert.equal(plan.routingDecision.selection.target.lane.accepted, false)
    assert.equal(plan.routingDecision.selection.target.lane.threshold, .7)
  }
  const { options, calls } = await fixture(answers(), { XAI_API_KEY: '', DEEPSEEK_API_KEY: '', KIMI_API_KEY: '' })
  const plan = await planTask(input, options)
  assert.equal(plan.route.provider, 'openai')
  assert.equal(calls[0].questions.external_target, undefined)
  assert.deepEqual(Object.keys(calls[0].questions.execution_lane.criteria), ['native_host'])
})

test('wrong-lane model answer cannot overturn a validated lane; unapproved requested route cannot either', async () => {
  const { options } = await fixture(answers('openai:gpt-6-astra'))
  const plan = await planTask({ ...input, requestedRoute: { provider: 'openai', model: 'gpt-6-astra', effort: 'max' } }, options)
  assert.equal(plan.route.provider, 'deepseek')
  assert.equal(plan.routingDecision.selection.target.jev.accepted, false)
  assert.equal(plan.routingDecision.selection.target.requested.reason, 'jev-authoritative')
})

test('safety and reviewer floors reject cheap external models without abandoning the external lane', async () => {
  const { options, calls } = await fixture({ ...answers(), worker: choice('scout'), effort: choice('low') })
  const high = await planTask({ task: 'Diagnose wallet settlement corruption', risk: 'high' }, options)
  assert.equal(high.route.role, 'deep_debugger'); assert.equal(high.route.model, 'deepseek-v4-pro')
  assert.equal(high.route.effort, 'high'); assert.equal(high.review.required, true)
  assert.equal(high.policy.contextProfile, 'expanded')
  assert.equal(calls[0].questions.external_target.criteria['deepseek:deepseek-flash'], undefined)
  const review = await reviewRoute(input, options)
  assert.equal(review.route.role, 'reviewer'); assert.equal(review.routingDecision.effective.role, 'reviewer')
  assert.equal(review.delegation.role, 'reviewer'); assert.equal(review.route.model, 'gpt-6-astra')
})

test('native route has workspace permission and never dispatches OpenAI API', async () => {
  const { options } = await fixture({ ...answers(), execution_lane: choice('native_host'), native_target: choice('openai:gpt-6-astra') })
  let invocations = 0; clearProviders(); registerProvider('openai', { execute: async () => { invocations++ } })
  const plan = await routeTask(input, options)
  assert.match(plan.delegation.instruction, /Use host workspace tools only within the assigned scope/)
  assert.equal(plan.delegation.agent.preferredFamily, 'astra')
  assert.equal(plan.delegation.agent.reasoning, plan.route.effort)
  assert.doesNotMatch(plan.delegation.instruction, /do not use shell/i)
  const result = await executeRoutedTask({ decisionId: plan.routingDecision.decisionId }, options)
  assert.equal(result.reason, 'native-host-agent-required'); assert.equal(invocations, 0)
  assert.equal(result.handoff.model, 'gpt-6-astra'); assert.equal(result.handoff.parentModelUnchanged, true)
})

test('direct review callers cannot relabel reviewers even with an authorized equal-or-higher-rank role', async () => {
  for (const role of ['deep_debugger', 'exceptional', 'engineer']) {
    const plan = await reviewRoute({ ...input, requestedRouteAuthorized: true, requestedRoute: { role, provider: 'openai', model: 'gpt-6-astra', effort: 'xhigh' } }, { env: {}, useJev: false })
    assert.equal(plan.routingDecision.effective.role, 'reviewer'); assert.equal(plan.delegation.role, 'reviewer')
    assert.equal(plan.routingDecision.selection.target.requested.reason, 'deterministic-role-floor')
  }
})

test('authorized model-only overrides map role effort for the new model; explicit invalid efforts still reject', async () => {
  const options = { env: { HARNESS_ENABLE_PAID_EXECUTION: 'true', KIMI_API_KEY: 'mock' }, useJev: false }
  const requestedRoute = { provider: 'kimi', model: 'kimi-k3' }
  const plan = await planTask({ ...input, requestedRoute, requestedRouteAuthorized: true }, options)
  assert.equal(plan.route.provider, 'kimi'); assert.equal(plan.route.effort, 'high')
  const invalid = await planTask({ ...input, requestedRoute: { ...requestedRoute, effort: 'ultra' }, requestedRouteAuthorized: true }, options)
  assert.equal(invalid.route.provider, 'openai')
  assert.equal(invalid.routingDecision.selection.target.requested.reason, 'unsupported-reasoning-effort')
})

test('pinned plans reject altered authority, evidence and targets before Jev or provider calls', async () => {
  const { options, calls } = await fixture(), executions = []
  clearProviders(); registerProvider('deepseek', adapter('deepseek', executions))
  const plan = await routeTask(input, options), decisionId = plan.routingDecision.decisionId
  plan.route.model = 'forged'; plan.delegation.context.task = 'forged'
  for (const extra of [{ task: 'different' }, { ownerAuthorizedRetry: true }, { requestedRoute: { model: 'gpt-6-astra' } }, { evidence: ['changed'] }, { idempotencyKey: 'fresh' }, { workspace: 'different' }, { executionState: {} }]) {
    const result = await executeRoutedTask({ decisionId, ...extra }, options)
    assert.equal(result.reason, 'pinned-decision-overrides-not-allowed')
  }
  assert.equal(calls.length, 1); assert.equal(executions.length, 0)
  const valid = await executeRoutedTask({ decisionId }, options)
  assert.equal(valid.target.model, 'deepseek-v4-pro'); assert.equal(executions[0].task, input.task)
})

test('execution rechecks paid gate and credentials, and expired/evicted decisions never reroute', async () => {
  const { options, calls } = await fixture(), plan = await routeTask(input, options), decisionId = plan.routingDecision.decisionId
  const gated = await executeRoutedTask({ decisionId }, { ...options, env: { ...options.env, HARNESS_ENABLE_PAID_EXECUTION: 'false' } })
  assert.equal(gated.reason, 'paid-execution-owner-gate-disabled')
  const noKey = await executeRoutedTask({ decisionId }, { ...options, env: { ...options.env, DEEPSEEK_API_KEY: '' } })
  assert.equal(noKey.reason, 'provider-not-ready')
  let now = 0; const cache = new PlanCache({ maxEntries: 1, ttlMs: 10, now: () => now })
  cache.remember(plan); now = 11
  const expired = await executeRoutedTask({ decisionId }, { ...options, planCache: cache })
  assert.equal(expired.reason, 'routing-decision-expired-or-unknown')
  now = 0; cache.remember(plan)
  cache.remember(await planTask({ ...input, task: 'Another bounded task' }, { env: {}, useJev: false }))
  assert.equal(cache.get(decisionId), null); assert.equal(calls.length, 1)
})

test('decision digest includes retry authority and workspace, not cache expiry', async () => {
  const options = { env: {}, useJev: false, planCache: new PlanCache() }
  const a = await routeTask(input, options), b = await routeTask({ ...input, ownerAuthorizedRetry: true, retryReason: 'new evidence', workspace: 'other' }, options)
  assert.notEqual(a.routingDecision.decisionId, b.routingDecision.decisionId)
  assert.equal((await routeTask(input, options)).routingDecision.decisionId, a.routingDecision.decisionId)
})

test('refreshed readiness does not label authentication failure or missing catalog model as ready', async () => {
  const result = await providerReadiness({ refresh: true }, { env: { XAI_API_KEY: 'mock', KIMI_API_KEY: 'mock' }, fetchImpl: async url => url.includes('x.ai') ? { ok: false, status: 401 } : { ok: true, json: async () => ({ data: [] }) } })
  assert.equal(result.statuses.xai.ready, false); assert.equal(result.statuses.kimi.ready, false)
  assert.equal(result.statuses.openai.ready, true)
})

test('MCP route to pinned execute calls Jev once and preserves all existing tool names', async () => {
  const { options, calls } = await fixture(), executions = []
  const server = createServer({ ...options, providers: { deepseek: adapter('deepseek', executions) } })
  const [client, transport] = InMemoryTransport.createLinkedPair(), pending = new Map(); let id = 0
  client.onmessage = message => { if (pending.has(message.id)) { const promise = pending.get(message.id); pending.delete(message.id); message.error ? promise.reject(new Error(JSON.stringify(message.error))) : promise.resolve(message.result) } }
  await server.connect(transport); await client.start()
  const request = (method, params = {}) => new Promise((resolve, reject) => { const next = ++id; pending.set(next, { resolve, reject }); void client.send({ jsonrpc: '2.0', id: next, method, params }) })
  try {
    await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'lane-test', version: '1' } })
    await client.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
    const names = (await request('tools/list')).tools.map(tool => tool.name)
    assert.equal(names.length, 14)
    for (const name of ['route_task', 'review_route', 'execute_routed_task', 'resume_routed_task', 'provider_readiness', 'provider_status', 'build_evidence_packet', 'create_delegation', 'check_action', 'check_continue', 'job_status', 'task_usage', 'cancel_job', 'model_catalog']) assert.ok(names.includes(name))
    const plan = JSON.parse((await request('tools/call', { name: 'route_task', arguments: input })).content[0].text)
    const executed = JSON.parse((await request('tools/call', { name: 'execute_routed_task', arguments: { decisionId: plan.routingDecision.decisionId } })).content[0].text)
    assert.equal(executed.execution.executed, true); assert.equal(calls.length, 1); assert.equal(executions.length, 1)
    const review = JSON.parse((await request('tools/call', { name: 'review_route', arguments: input })).content[0].text)
    assert.equal(review.route.role, 'reviewer'); assert.equal(review.routingDecision.effective.role, 'reviewer')
    assert.equal(calls.length, 1)
  } finally { await client.close() }
})

test('one Jev request produces pinned heterogeneous assignments and each executes exactly once', async () => {
  const response = {
    ...answers('deepseek:deepseek-v4-pro'),
    execution_lane: choice('native_host'), native_target: choice('openai:gpt-5.6-luna'), effort: choice('medium'),
    parallel_required: { type: 'noul', noul: .95 }, parallel_justification: choice('independent'),
    workstream_0_execution_lane: choice('native_host'), workstream_0_native_target: choice('openai:gpt-6-astra'), workstream_0_external_target: choice('deepseek:deepseek-v4-pro'), workstream_0_effort: choice('high'),
    workstream_1_execution_lane: choice('external_api'), workstream_1_native_target: choice('openai:gpt-5.6-luna'), workstream_1_external_target: choice('deepseek:deepseek-v4-pro'), workstream_1_effort: choice('low'),
    workstream_2_execution_lane: choice('external_api'), workstream_2_native_target: choice('openai:gpt-5.6-luna'), workstream_2_external_target: choice('kimi:kimi-k3'), workstream_2_effort: choice('low')
  }
  const { options, calls } = await fixture(response), deepseekCalls = [], kimiCalls = []
  clearProviders(); registerProvider('deepseek', adapter('deepseek', deepseekCalls)); registerProvider('kimi', adapter('kimi', kimiCalls))
  const workstreams = [
    { id: 'repository-check', task: 'Inspect repository callers and run tests', files: ['src/callers.js'], tests: ['test/callers.test.js'] },
    { id: 'bounded-patch', task: 'Patch the complete supplied clamp helper', rootCause: 'upper bound is wrong', evidence: ['export const clamp=(v,lo,hi)=>Math.min(lo,Math.max(lo,v))'], files: ['src/clamp.js'], tests: ['test/clamp.test.js'] },
    { id: 'bounded-review', task: 'Review this complete supplied guard', evidence: ['export const allowed=x=>x!==null'], files: ['src/guard.js'], tests: ['test/guard.test.js'] }
  ]
  const plan = await routeTask({ ...input, workstreams, routingPhaseId: 'mixed-phase' }, options)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].state.workstreams.length, 3)
  assert.equal(calls[0].state.workstreams[1].evidence[0], workstreams[1].evidence[0])
  for (const index of [0, 1, 2]) {
    assert.ok(calls[0].questions[`workstream_${index}_execution_lane`])
    assert.ok(calls[0].questions[`workstream_${index}_native_target`])
    if(index===0)assert.equal(calls[0].questions[`workstream_${index}_external_target`],undefined)
    else assert.ok(calls[0].questions[`workstream_${index}_external_target`])
    assert.ok(calls[0].questions[`workstream_${index}_effort`])
  }
  const assignments = plan.routingDecision.parallel.assignments
  assert.equal(assignments.length, 3); assert.equal(plan._workstreamPlans, undefined)
  assert.equal(plan.routingDecision.handoff.mode, 'mixed')
  assert.equal(plan.routingDecision.handoff.scope, 'workstream-assignments')
  assert.equal(plan.routingDecision.handoff.orchestration.strategy, 'heterogeneous-non-overlapping')
  assert.deepEqual(assignments.map(value => [value.id, value.effective.provider, value.effective.model, value.effective.effort]), [
    ['repository-check', 'openai', 'gpt-5.6-luna', 'max'],
    ['bounded-patch', 'deepseek', 'deepseek-v4-pro', 'low'],
    ['bounded-review', 'kimi', 'kimi-k3', 'low']
  ])
  assert.equal(new Set(assignments.map(value => value.decisionId)).size, 3)
  assert.match(assignments[1].delegation.instruction, /Do not use shell, filesystem/)
  assert.equal(assignments[1].delegation.context.evidence[0], workstreams[1].evidence[0])
  const native = await executeRoutedTask({ decisionId: assignments[0].decisionId }, options)
  const deepseek = await executeRoutedTask({ decisionId: assignments[1].decisionId }, options)
  const kimi = await executeRoutedTask({ decisionId: assignments[2].decisionId }, options)
  assert.equal(native.reason, 'native-host-agent-required'); assert.equal(native.target.model, 'gpt-5.6-luna')
  assert.equal(deepseek.execution.executed, true); assert.equal(kimi.execution.executed, true)
  assert.equal(deepseekCalls[0].task, workstreams[1].task); assert.equal(kimiCalls[0].task, workstreams[2].task)
  assert.equal(calls.length, 1)
  const replay = await executeRoutedTask({ decisionId: assignments[1].decisionId }, options)
  assert.equal(replay.execution.reason, 'idempotent-replay'); assert.equal(deepseekCalls.length, 1)
})

test('incomplete workstream advice falls back every assignment to native without weakening bounds', async () => {
  const response = {
    ...answers(),
    workstream_0_execution_lane: choice('external_api'), workstream_0_external_target: choice('deepseek:deepseek-v4-pro'), workstream_0_native_target: choice('openai:gpt-5.6-luna'), workstream_0_effort: choice('low')
  }
  const { options } = await fixture(response)
  const workstreams = [
    { id: 'a', task: 'first', evidence: ['a'.repeat(5000)], files: ['a.js'] },
    { id: 'b', task: 'second', files: ['b.js'] }
  ]
  const plan = await routeTask({ ...input, workstreams }, options)
  assert.equal(plan.routingDecision.parallel.assignments.length, 2)
  assert.ok(plan.routingDecision.parallel.assignments.every(value => value.effective.executionMode === 'native_host'))
  assert.equal(plan.routingDecision.parallel.assignments[0].delegation.context.truncation.occurred, true)
})

test('one malformed workstream answer makes the assignment set fall back atomically', async () => {
  const response = {
    ...answers(),
    workstream_0_execution_lane: choice('external_api'), workstream_0_external_target: choice('deepseek:deepseek-v4-pro'), workstream_0_native_target: choice('openai:gpt-5.6-luna'), workstream_0_effort: choice('low'),
    workstream_1_execution_lane: { type: 'choice', choice: 'unknown_lane', confidence: .99 }, workstream_1_external_target: choice('kimi:kimi-k3'), workstream_1_native_target: choice('openai:gpt-5.6-luna'), workstream_1_effort: choice('low')
  }
  const { options } = await fixture(response)
  const plan = await routeTask({ ...input, workstreams: [
    { id: 'a', task: 'first', evidence: ['complete a'], files: ['a.js'] },
    { id: 'b', task: 'second', evidence: ['complete b'], files: ['b.js'] }
  ] }, options)
  assert.ok(plan.routingDecision.parallel.assignments.every(value => value.effective.executionMode === 'native_host'))
  assert.equal(plan.routingDecision.dispatch, null)
})

test('a high-risk workstream receives its own deterministic capability and review floors', async () => {
  const options = { env: {}, useJev: false, planCache: new PlanCache() }
  const plan = await routeTask({ task: 'Refactor independent helpers', workstreams: [
    { id: 'ordinary', task: 'Refactor a display helper', files: ['src/display.js'] },
    { id: 'sensitive', task: 'Deploy production and execute wallet settlement', files: ['src/settlement.js'] }
  ] }, options)
  const [ordinary,sensitive]=plan.routingDecision.parallel.assignments
  assert.equal(plan.packet.risk,'normal');assert.equal(ordinary.effective.role,'engineer')
  assert.equal(sensitive.effective.role,'deep_debugger');assert.equal(sensitive.effective.model,'gpt-6-astra');assert.equal(sensitive.effective.effort,'xhigh')
  const execution=await executeRoutedTask({decisionId:sensitive.decisionId},options)
  assert.equal(execution.plan.packet.risk,'high');assert.equal(execution.plan.review.required,true)
  assert.equal(execution.plan.policy.contextProfile,'expanded');assert.equal(execution.plan.policy.retrievalMode,'exploratory')
})

test('a screened high-risk root cause remains unknown and cannot weaken safety floors', async () => {
  const options = { env: {}, useJev: false, planCache: new PlanCache() }
  const plan = await routeTask({ task: 'Refactor independent helpers', workstreams: [
    { id: 'ordinary', task: 'Refactor a display helper', files: ['src/display.js'] },
    { id: 'sensitive', task: 'Deploy production and execute wallet settlement', rootCause: 'api_key=abcdefghijklmnop', files: ['src/settlement.js'] }
  ] }, options)
  const sensitive=plan.routingDecision.parallel.assignments[1]
  const execution=await executeRoutedTask({decisionId:sensitive.decisionId},options)
  assert.equal(execution.plan.packet.rootCause,null)
  assert.ok(execution.plan.packet.truncation.removed.includes('rootCause:secret-like'))
  assert.equal(sensitive.effective.role,'deep_debugger');assert.equal(execution.plan.review.required,true)
  assert.equal(execution.plan.policy.contextProfile,'expanded');assert.equal(execution.plan.policy.retrievalMode,'exploratory')
})

test('raw traversal or screened ownership paths disable workstream assignments', async () => {
  const options = { env: {}, useJev: false, planCache: new PlanCache() }
  for (const unsafe of ['src/../a.js','.env/config']) {
    const plan=await routeTask({task:'Refactor independent helpers',workstreams:[
      {id:'a',task:'first',files:[unsafe]},{id:'b',task:'second',files:['b.js']}
    ]},options)
    assert.equal(plan.routingDecision.parallel.nonOverlapping,false)
    assert.deepEqual(plan.routingDecision.parallel.assignments,[])
    assert.ok(plan.routingDecision.parallel.issues.some(value=>value.reason==='ambiguous-file-ownership'))
  }
})

test('ownership that cannot fit every assignment profile fails closed before routing', async () => {
  const options = { env: {}, useJev: false, planCache: new PlanCache() }
  const plan=await routeTask({task:'Refactor independent helpers',workstreams:[
    {id:'a',task:'first',files:['a.js','b.js','c.js','d.js']},{id:'b',task:'second',files:['e.js']}
  ]},options)
  assert.equal(plan.routingDecision.parallel.nonOverlapping,false)
  assert.deepEqual(plan.routingDecision.parallel.assignments,[])
  assert.ok(plan.routingDecision.parallel.issues.some(value=>value.reason==='workstream-ownership-exceeds-assignment-bounds'))
})

test('overlap or dependency disables per-workstream decisions and cache keys change with ownership', async () => {
  const invalid = [
    [{ id: 'a', task: 'first', files: ['shared.js'] }, { id: 'b', task: 'second', files: ['shared.js'] }],
    [{ id: 'a', task: 'first', files: ['a.js'] }, { id: 'b', task: 'second', files: ['b.js'], dependsOn: ['a'] }]
  ]
  for (const workstreams of invalid) {
    const { options, calls } = await fixture()
    const plan = await routeTask({ ...input, workstreams }, options)
    assert.deepEqual(plan.routingDecision.parallel.assignments, [])
    assert.equal(plan.routingDecision.parallel.effective, 1)
    assert.deepEqual(calls[0].state.workstreams, [])
    assert.equal(calls[0].questions.workstream_0_execution_lane, undefined)
  }
  const deterministic = { env: {}, useJev: false, planCache: new PlanCache() }
  const one = await routeTask({ ...input, workstreams: [{ id: 'a', task: 'first', files: ['a.js'] }, { id: 'b', task: 'second', files: ['b.js'] }] }, deterministic)
  const two = await routeTask({ ...input, workstreams: [{ id: 'a', task: 'first', files: ['a2.js'] }, { id: 'b', task: 'second', files: ['b.js'] }] }, deterministic)
  assert.notEqual(one.routingDecision.decisionId, two.routingDecision.decisionId)
  assert.equal(one.routingDecision.parallel.assignments.length, 2)
  assert.ok(one.routingDecision.parallel.assignments.every(value => value.effective.executionMode === 'native_host'))
})
