import test from 'node:test'
import assert from 'node:assert/strict'
import { askRoutingJev } from '../src/router/jev.js'
import { resolveBudget, checkExecutionBudget } from '../src/budget/executionBudget.js'
import { resolveRoleTarget } from '../src/execution/roleResolver.js'
import { planTask } from '../src/orchestrator.js'
import { AccountingStore } from '../src/execution/accountingStore.js'

test('parallel defaults to three', () => assert.equal(resolveBudget().maxParallel, 3))
test('parallel budget blocks fourth active task', () => assert.equal(checkExecutionBudget({ active: 3 }, resolveBudget()).allowed, false))
test('models are runtime configured', () => assert.equal(resolveRoleTarget('engineer', { HARNESS_ENGINEER_MODEL: 'x' }).model, 'x'))

test('Jev contract normalizes live shape offline', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ model: 'jev-1.13.0', answers: { worker: { type: 'choice', choice: 'scout', confidence: 1, probabilities: { scout: 1 } }, expand_context: { type: 'noul', noul: .1 }, review_required: { type: 'noul', noul: .2 } }, usage: { input_tokens: 10, output_tokens: 3 } }) })
  const env = { TYPESAFE_API_KEY: 'test', HARNESS_ENABLE_PAID_EXECUTION: 'true', HARNESS_JEV_CALL_COST_USD: '.01' }
  const result = await askRoutingJev({ task: 'find callers', risk: 'normal', rootCause: null, evidence: [] }, { env, store: new AccountingStore(), fetchImpl })
  assert.equal(result.worker.choice, 'scout')
  assert.equal(result.model, 'jev-1.13.0')
})

test('Jev cannot downgrade unknown high-risk work', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ model: 'jev', answers: { worker: { type: 'choice', choice: 'scout', confidence: 1, probabilities: { scout: 1 } }, expand_context: { type: 'noul', noul: 0 }, review_required: { type: 'noul', noul: 1 } }, usage: {} }) })
  const env = { TYPESAFE_API_KEY: 'x', HARNESS_ENABLE_PAID_EXECUTION: 'true', HARNESS_JEV_CALL_COST_USD: '.01' }
  const plan = await planTask({ task: 'wallet settlement mismatch', risk: 'high' }, { env, store: new AccountingStore(), fetchImpl })
  assert.equal(plan.route.role, 'deep_debugger')
})
