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
const answers = (target = 'deepseek:deepseek-flash', confidence = .91) => ({ worker: choice('engineer'), execution_lane: choice('external_api'), external_target: choice(target, confidence), native_target: choice('openai:gpt-5.6-luna'), effort: choice('high', .2), review_required: { type: 'noul', noul: .9 } })
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
  assert.deepEqual(Object.keys(sent.questions.external_target.criteria), ['deepseek:deepseek-flash', 'deepseek:deepseek-v4-pro'])
  assert.match(sent.questions.native_target.instructions, /Independently/)
  assert.match(sent.questions.external_target.instructions, /Independently/)
  assert.match(sent.questions.effort.instructions, /Do not condition on any other answer/)
  assert.match(sent.questions.execution_lane.instructions, /file paths alone are not source content/)
  assert.equal(plan.advice.target.choice, 'deepseek:deepseek-flash')
  assert.equal(plan.advice.reviewRequired.probability, .9)
  assert.equal(plan.review.recommended, true)
})

test('all three external providers survive uncertain effort and actually dispatch the selected model', async () => {
  for (const [provider, model] of [['deepseek', 'deepseek-flash'], ['xai', 'grok-4.6'], ['kimi', 'kimi-k3']]) {
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

test('confident external lane retains cheapest capable external fallback with uncertain model and effort', async () => {
  const { options } = await fixture(answers('kimi:kimi-k3', .25))
  const plan = await planTask(input, options)
  assert.equal(plan.route.provider, 'deepseek'); assert.equal(plan.route.model, 'deepseek-flash')
  assert.equal(plan.route.effort, 'high') // upward mapping of the medium default
  assert.equal(plan.routingDecision.selection.target.source, 'jev-lane-deterministic-target')
  assert.equal(plan.routingDecision.selection.target.jev.accepted, false)
})

test('confident task effort applies even when the model falls back within the accepted lane', async () => {
  const { options } = await fixture({ ...answers('kimi:kimi-k3', .25), effort: choice('max') })
  const plan = await planTask(input, options)
  assert.equal(plan.route.model, 'deepseek-flash'); assert.equal(plan.route.effort, 'max')
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
  assert.equal(review.delegation.role, 'reviewer'); assert.equal(review.route.model, 'deepseek-v4-pro')
})

test('native route has workspace permission and never dispatches OpenAI API', async () => {
  const { options } = await fixture({ ...answers(), execution_lane: choice('native_host'), native_target: choice('openai:gpt-5.6-sol') })
  let invocations = 0; clearProviders(); registerProvider('openai', { execute: async () => { invocations++ } })
  const plan = await routeTask(input, options)
  assert.match(plan.delegation.instruction, /Use host workspace tools only within the assigned scope/)
  assert.equal(plan.delegation.agent.preferredFamily, 'sol')
  assert.equal(plan.delegation.agent.reasoning, plan.route.effort)
  assert.doesNotMatch(plan.delegation.instruction, /do not use shell/i)
  const result = await executeRoutedTask({ decisionId: plan.routingDecision.decisionId }, options)
  assert.equal(result.reason, 'native-host-agent-required'); assert.equal(invocations, 0)
  assert.equal(result.handoff.model, 'gpt-5.6-sol'); assert.equal(result.handoff.parentModelUnchanged, true)
})

test('direct review callers cannot relabel reviewers even with an authorized equal-or-higher-rank role', async () => {
  for (const role of ['deep_debugger', 'exceptional', 'engineer']) {
    const plan = await reviewRoute({ ...input, requestedRouteAuthorized: true, requestedRoute: { role, provider: 'openai', model: 'gpt-6-astra', effort: 'max' } }, { env: {}, useJev: false })
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
  assert.equal(valid.target.model, 'deepseek-flash'); assert.equal(executions[0].task, input.task)
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
    assert.equal(calls.length, 2)
  } finally { await client.close() }
})
