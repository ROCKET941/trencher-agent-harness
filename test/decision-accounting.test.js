import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { withDecisionTrace } from '../src/router/decisionTrace.js'
import { planTask } from '../src/orchestrator.js'
import { askJev, askRoutingJev } from '../src/router/jev.js'
import { AccountingStore } from '../src/execution/accountingStore.js'
import { reconcileJevUsage } from '../src/execution/jevAccounting.js'
import { reviewRoute } from '../src/mcp/tools.js'

const env = { TYPESAFE_API_KEY: 'test-only-secret', HARNESS_ENABLE_PAID_EXECUTION: 'true', HARNESS_JEV_CALL_COST_USD: '.07' }
const tempStore = async () => new AccountingStore({ file: path.join(await mkdtemp(path.join(os.tmpdir(), 'decision-accounting-')), 'ledger.json'), env })
const response = usage => ({ ok: true, status: 200, json: async () => ({ model: 'jev', answers: {}, usage }) })

test('decision trace is canonical, stable on reuse, and changes with evidence, target, or phase', async () => {
  const plan = await planTask({ task: 'Fix a localized display issue', rootCause: 'wrong prop', evidence: ['line 9'], routingPhaseId: 'phase-1' }, { useJev: false })
  const first = plan
  const reordered = { ...plan, packet: Object.fromEntries(Object.entries(plan.packet).reverse()), advice: { job: { id: 'volatile' }, cacheHit: true } }
  assert.equal(withDecisionTrace(reordered).routingDecision.decisionId, first.routingDecision.decisionId)
  assert.equal(withDecisionTrace(first).routingDecision.decisionId, first.routingDecision.decisionId)
  assert.match(first.routingDecision.decisionId, /^route_[a-f0-9]{32}$/)
  assert.match(first.routingDecision.payloadDigest, /^[a-f0-9]{64}$/)
  assert.match(first.routingDecision.evidenceDigest, /^[a-f0-9]{64}$/)
  assert.equal(first.route.routingDecision, first.routingDecision)
  for (const changed of [
    { ...plan, packet: { ...plan.packet, evidence: ['line 10'] } },
    { ...plan, routingDecision: { ...plan.routingDecision, effective: { ...plan.routingDecision.effective, effort: 'high' } } },
    { ...plan, routingDecision: { ...plan.routingDecision, planReuse: { ...plan.routingDecision.planReuse, routingPhaseId: 'phase-2' } } }
  ]) assert.notEqual(withDecisionTrace(changed).routingDecision.decisionId, first.routingDecision.decisionId)
})

test('blocked routes get stable identifiers without exposing screened secret evidence', async () => {
  const plan = await planTask({ task: 'bounded work', evidence: ['api_key=private-value'], attempts: [{}, {}] }, { useJev: false })
  assert.equal(plan.delegation, null)
  assert.match(plan.routingDecision.decisionId, /^route_[a-f0-9]{32}$/)
  assert.doesNotMatch(JSON.stringify(plan), /private-value/)
})

test('review route recomputes trace for its reviewer override', async () => {
  const input = { task: 'Review bounded component', rootCause: 'implementation-complete' }
  const normal = await planTask(input, { useJev: false })
  const review = await reviewRoute(input, { useJev: false })
  assert.equal(review.route.role, 'reviewer')
  assert.equal(review.route.routingDecision, review.routingDecision)
  assert.notEqual(review.routingDecision.decisionId, normal.routingDecision.decisionId)
  assert.equal(withDecisionTrace(review).routingDecision.decisionId, review.routingDecision.decisionId)
})

test('Jev input billing accepts zero and aliases, ignores output price, and never clamps measured cost', () => {
  assert.equal(reconcileJevUsage({ input_tokens: 0, output_tokens: 999999 }, .07).actualCostUsd, 0)
  assert.equal(reconcileJevUsage({ inputTokens: 1_000_000, outputTokens: 999999 }, .07).actualCostUsd, .042)
  assert.equal(reconcileJevUsage({ inputTokens: 1_000_000 }, .07, { inputUsdPerMillion: .084 }).actualCostUsd, .084)
  assert.equal(reconcileJevUsage({ input_tokens: 10_000_000 }, .07).actualCostUsd, .42)
  for (const value of [undefined, null, -1, 1.5, Infinity, NaN, '10', true]) {
    const result = reconcileJevUsage({ input_tokens: value }, .07)
    assert.equal(result.actualCostUsd, .07)
    assert.equal(result.costBasis, 'conservative-reservation')
    assert.equal(result.usage, null)
  }
})

test('Jev preserves preflight reservation and persists reconciled task/day usage', async () => {
  const store = await tempStore()
  const result = await askJev({ state: { task: 'usage reconciliation' }, questions: {} }, { env, store, fetchImpl: async () => {
    const active = Object.values(JSON.parse(await readFile(store.file, 'utf8')).jobs)[0]
    assert.equal(active.status, 'running')
    assert.equal(active.reservedCostUsd, .07)
    return response({ input_tokens: 1_000_000, output_tokens: 900000 })
  } })
  assert.equal(result.job.actualCostUsd, .042)
  assert.equal(result.job.costBasis, 'reported-input-usage')
  const restarted = new AccountingStore({ file: store.file, env })
  const usage = await restarted.getUsage(result.taskId)
  assert.equal(usage.task.actualCostUsd, .042)
  assert.equal(usage.daily.actualCostUsd, .042)
  assert.equal(usage.task.reservedCostUsd, 0)
  assert.equal(usage.task.inputTokens, 1_000_000)
  assert.equal(usage.task.outputTokens, 900000)
  assert.equal(usage.task.starts, 0)
  assert.equal(usage.task.auxiliaryStarts, 1)
  assert.doesNotMatch(await readFile(store.file, 'utf8'), /test-only-secret/)
})

test('Jev missing usage retains the bound and cached advice does not bill twice', async () => {
  const store = await tempStore()
  let calls = 0
  const packet = { task: 'cached accounting case 111', risk: 'normal', evidence: [] }
  const options = { env, store, fetchImpl: async () => { calls++; return response({}) } }
  const first = await askRoutingJev(packet, options), second = await askRoutingJev(packet, options)
  assert.equal(first.job.actualCostUsd, .07)
  assert.equal(first.job.costBasis, 'conservative-reservation')
  assert.equal(second.cacheHit, true)
  assert.equal(calls, 1)
  assert.equal((await store.getUsage(first.taskId)).task.actualCostUsd, .07)
})

test('successful retry after an ambiguous transport failure retains conservative billing', async () => {
  const store = await tempStore()
  let calls = 0
  const result = await askJev({ state: { task: 'ambiguous retry' }, questions: {} }, { env, store, maxRetries: 1, fetchImpl: async () => {
    if (++calls === 1) throw new TypeError('network dropped after dispatch')
    return response({ input_tokens: 100, output_tokens: 1 })
  } })
  assert.equal(result.available, true)
  assert.equal(result.job.actualCostUsd, .07)
  assert.equal(result.job.costBasis, 'conservative-reservation')
})
