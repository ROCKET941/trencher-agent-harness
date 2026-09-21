import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { planTask } from '../src/orchestrator.js'
import { AccountingStore } from '../src/execution/accountingStore.js'

const choice = (choice, confidence = .9) => ({ type: 'choice', choice, confidence })
const noul = noul => ({ type: 'noul', noul })
async function advised(answers, input = {}, overrides = {}) {
  const env = { TYPESAFE_API_KEY: 'test', XAI_API_KEY: 'mock', HARNESS_ENABLE_PAID_EXECUTION: 'true', HARNESS_JEV_CALL_COST_USD: '.01', ...overrides }
  const store = new AccountingStore({ file: path.join(await mkdtemp(path.join(os.tmpdir(), 'routing-confidence-')), 'ledger.json'), env })
  const fetchImpl = async () => ({ ok: true, json: async () => ({ answers }) })
  return planTask({ task: 'implement bounded module', rootCause: 'known', ...input }, { env, store, fetchImpl, useCache: false })
}

test('separate confident model and effort choices remain authoritative', async () => {
  const plan = await advised({ worker: choice('engineer'), target: choice('xai:grok-4.6', .72), effort: choice('high', .74) })
  assert.equal(plan.route.provider, 'xai')
  assert.equal(plan.route.model, 'grok-4.6')
  assert.equal(plan.route.effort, 'high')
  assert.equal(plan.routingDecision.selection.target.source, 'jev')
  assert.equal(plan.routingDecision.selection.target.jev.effortConfidence, .74)
})

test('low or invalid model confidence triggers a transparent cheap fallback', async () => {
  for (const [modelConfidence, effortConfidence] of [[.5,.9],[1.1,.9]]) {
    const plan = await advised({ worker: choice('engineer'), target: choice('openai:gpt-6-astra', modelConfidence), effort: choice('high', effortConfidence) })
    assert.equal(plan.route.model, 'gpt-5.6-luna')
    assert.equal(plan.route.effort, 'medium')
    assert.equal(plan.routingDecision.selection.target.jev.reason, 'insufficient-confidence')
    assert.equal(plan.routingDecision.selection.target.jev.threshold, .70)
  }
})

test('uncertain, missing or unsupported effort preserves a confident model with safe default effort', async () => {
  for (const effort of [undefined, choice('ultra'), choice('high', .5), choice('high', -.1)]) {
    const plan = await advised({ target: choice('openai:gpt-6-astra'), effort })
    assert.equal(plan.route.model, 'gpt-6-astra')
    assert.equal(plan.route.effort, 'medium')
    assert.equal(plan.routingDecision.selection.target.jev.accepted, true)
    assert.equal(plan.routingDecision.selection.target.jev.effortAccepted, false)
  }
})

test('high risk retrieval and invalid environment targets cannot bypass capability floors', async () => {
  for (const model of ['gpt-5.6-luna', 'invented-model']) {
    const plan = await advised({ worker: choice('scout'), target: choice('openai:gpt-5.6-luna'), effort: choice('medium') }, { task: 'find the cause of wallet settlement corruption', risk: 'high', rootCause: null }, { HARNESS_DEBUG_MODEL: model })
    assert.equal(plan.route.role, 'deep_debugger')
    assert.equal(plan.route.model, 'gpt-5.6-sol')
    assert.equal(plan.review.required, true)
    assert.ok(plan.routingDecision.overrides.some(override => override.field === 'configuredTarget'))
  }
})

test('ambiguous parallel advice stays single even under obsolete low threshold configuration', async () => {
  const plan = await advised({ parallel_required: noul(.51), parallel_justification: choice('independent') }, {}, { JEV_PARALLEL_THRESHOLD: '.50' })
  assert.equal(plan.routingDecision.parallel.effective, 1)
  assert.equal(plan.routingDecision.parallel.threshold, .80)
})

test('strong parallel probability also requires a confident independent justification', async () => {
  const plan = await advised({ parallel_required: noul(.95), parallel_justification: choice('independent', .5) })
  assert.equal(plan.routingDecision.parallel.effective, 1)
})

test('two or three explicit independent owned workstreams qualify without Jev', async () => {
  for (const count of [2,3]) {
    const workstreams = Array.from({ length: count }, (_, i) => ({ id: `w${i}`, task: `implement component ${i}`, files: [`src/component-${i}.js`], tests: [`test/component-${i}.test.js`] }))
    const plan = await planTask({ task: 'implement bounded components', workstreams }, { useJev: false, env: {} })
    assert.equal(plan.routingDecision.parallel.effective, count)
    assert.equal(plan.routingDecision.parallel.decisionSource, 'validated-workstreams')
  }
})

test('missing ownership, dependencies, path aliases, test collisions and duplicate IDs cannot fan out', async () => {
  const cases = [
    [{ id: 'a', task: 'first' }, { id: 'b', task: 'second' }],
    [{ id: 'a', task: 'first', files: ['a.js'] }, { id: 'b', task: 'second', files: ['b.js'], dependsOn: ['a'] }],
    [{ id: 'a', task: 'first', files: ['./src/shared.js'] }, { id: 'b', task: 'second', files: ['SRC\\shared.js'] }],
    [{ id: 'a', task: 'first', files: ['a.js'], tests: ['shared.test.js'] }, { id: 'b', task: 'second', files: ['b.js'], tests: ['shared.test.js'] }],
    [{ id: 'a', task: 'first', files: ['src'] }, { id: 'b', task: 'second', files: ['src/b.js'] }],
    [{ id: 'a', task: 'first', files: ['a.js'] }, { id: 'a', task: 'second', files: ['b.js'] }],
    [{ id: 'a', task: 'first', files: ['src/*.js'] }, { id: 'b', task: 'second', files: ['b.js'] }]
  ]
  for (const workstreams of cases) {
    const plan = await advised({ parallel_required: noul(.95), parallel_justification: choice('independent') }, { workstreams })
    assert.equal(plan.routingDecision.parallel.nonOverlapping, false)
    assert.equal(plan.routingDecision.parallel.effective, 1)
  }
})
