import test from 'node:test'
import assert from 'node:assert/strict'
import { createEvidencePacket } from '../src/context/evidencePacket.js'
import { askRoutingJev, normalizeContextProfile, normalizeRetrievalMode } from '../src/router/jev.js'
import { planTask } from '../src/orchestrator.js'
import { executeDelegation } from '../src/execution/executor.js'
import { registerProvider, clearProviders } from '../src/providers/registry-v12.js'
import { normalizeResult } from '../src/providers/base.js'
import { AccountingStore } from '../src/execution/accountingStore.js'

const choice = (value, confidence = 1) => ({ type: 'choice', choice: value, confidence, probabilities: { [value]: 1 } })
const noul = probability => ({ type: 'noul', noul: probability })
const jevFetch = answers => async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ model: 'jev-test', answers, usage: {} }) })
const jevEnv = { TYPESAFE_API_KEY: 'x', HARNESS_ENABLE_PAID_EXECUTION: 'true', HARNESS_JEV_CALL_COST_USD: '.01' }

test('Jev context profile normalization accepts only known profiles', () => {
  assert.equal(normalizeContextProfile(choice('tight')).choice, 'tight')
  assert.equal(normalizeContextProfile(choice('unlimited')), null)
})

test('Jev retrieval mode normalization accepts only known modes', () => {
  assert.equal(normalizeRetrievalMode(choice('adjacent')).choice, 'adjacent')
  assert.equal(normalizeRetrievalMode(choice('broad')), null)
})

test('evidence entries are size capped with visible truncation', () => {
  const packet = createEvidencePacket({ task: 'x'.repeat(10000), evidence: ['a'.repeat(10000)] })
  assert.ok(packet.task.length <= 4000)
  assert.ok(packet.evidence[0].length <= 3000)
  assert.match(packet.evidence[0], /\[truncated\]/)
})

test('initial evidence packets remove secret-like material and unsafe paths',()=>{
  const fakeSecret=['OPENAI_API_KEY=','sk-','example-secret-value'].join(''),packet=createEvidencePacket({task:'inspect safely',evidence:[fakeSecret,'safe fact'],files:['.env','src/app.js'],inspected:[{path:'../secrets/key.txt',range:'1-2'},{path:'src/app.js',range:'3-4'}]})
  assert.deepEqual(packet.evidence,['safe fact']);assert.deepEqual(packet.files,['src/app.js']);assert.deepEqual(packet.inspected.map(item=>item.path),['src/app.js']);assert.equal(JSON.stringify(packet).includes(fakeSecret),false);assert.equal(packet.truncation.occurred,true);assert.ok(packet.truncation.removed.length>=3)
})

test('normal evidence array count limits remain compatible', () => {
  const packet = createEvidencePacket({ files: Array.from({ length: 20 }, (_, index) => `f${index}`), tests: Array(10).fill('t'), docs: Array(10).fill('d') })
  assert.deepEqual([packet.files.length, packet.tests.length, packet.docs.length], [6, 3, 2])
})

test('context profile changes delegation bounds', async () => {
  const input = { task: 'change named files', rootCause: 'known', files: Array.from({ length: 9 }, (_, index) => `f${index}`) }
  const tight = await planTask(input, { env: jevEnv, store:new AccountingStore(), fetchImpl: jevFetch({ worker: choice('engineer'), context_profile: choice('tight'), retrieval_mode: choice('exact'), expand_context: noul(0), review_required: noul(0) }) })
  assert.equal(tight.delegation.context.files.length, 3)
  assert.equal(tight.delegation.policy.contextProfile, 'tight')
})

test('Jev unavailable uses deterministic context and retrieval fallback', async () => {
  const plan = await planTask({ task: 'implement panel' }, { env: {} })
  assert.equal(plan.policy.contextProfile, 'normal')
  assert.equal(plan.policy.retrievalMode, 'adjacent')
})

test('low-confidence advice does not broaden deterministic policy', async () => {
  const plan = await planTask({ task: 'fix named file', rootCause: 'known', files: ['src/a.js'] }, { env: {...jevEnv,JEV_MIN_CONFIDENCE:'.70'}, store:new AccountingStore(), fetchImpl: jevFetch({ worker: choice('deep_debugger', .2), context_profile: choice('expanded', .2), retrieval_mode: choice('exploratory', .2), expand_context: noul(1), review_required: noul(0) }) })
  assert.equal(plan.route.role, 'engineer')
  assert.equal(plan.policy.contextProfile, 'tight')
  assert.equal(plan.policy.retrievalMode, 'adjacent')
})

test('Jev cannot escalate an evidence-free normal task', async () => {
  const plan = await planTask({ task: 'implement panel' }, { env: jevEnv, store:new AccountingStore(), fetchImpl: jevFetch({ worker: choice('deep_debugger'), context_profile: choice('normal'), retrieval_mode: choice('adjacent'), expand_context: noul(0), review_required: noul(0) }) })
  assert.equal(plan.route.role, 'engineer')
})

test('tight profile also bounds shared fact and inspection pointers', () => {
  const packet = createEvidencePacket({ facts: Array.from({ length: 20 }, (_, index) => ({ claim: `fact ${index}`, source: `a:${index}` })), inspected: Array.from({ length: 30 }, (_, index) => ({ path: `f${index}`, range: '1-2', digest: `${index}` })) }, { contextProfile: 'tight' })
  assert.equal(packet.facts.length, 4)
  assert.equal(packet.inspected.length, 6)
})

test('compact shared facts and inspection pointers are included in the Jev state', async () => {
  let sent
  const fetchImpl = async (_url, request) => { sent = JSON.parse(request.body); return jevFetch({})(_url, request) }
  await askRoutingJev(createEvidencePacket({ task: 'follow up', facts: [{ claim: 'caller found', source: 'src/a.js:10' }], inspected: [{ path: 'src/a.js', range: '1-20', digest: 'abc' }] }), { env: jevEnv, store:new AccountingStore(), fetchImpl })
  assert.equal(sent.state.facts[0].claim, 'caller found')
  assert.equal(sent.state.inspected[0].path, 'src/a.js')
})

test('unjustified expanded and exploratory advice is denied', async () => {
  const plan = await planTask({ task: 'fix named file', rootCause: 'known', files: ['src/a.js'] }, { env: jevEnv, store:new AccountingStore(), fetchImpl: jevFetch({ worker: choice('engineer'), context_profile: choice('expanded'), retrieval_mode: choice('exploratory'), expand_context: noul(1), review_required: noul(0) }) })
  assert.notEqual(plan.policy.contextProfile, 'expanded')
  assert.notEqual(plan.policy.retrievalMode, 'exploratory')
  assert.equal(plan.policy.expansionAllowed, false)
})

test('expandContext false caps exploratory retrieval at adjacent', async () => {
  const plan = await planTask({ task: 'investigate issue', openQuestions: ['Which direct dependency fails?'] }, { env: jevEnv, store:new AccountingStore(), fetchImpl: jevFetch({ worker: choice('engineer'), context_profile: choice('normal'), retrieval_mode: choice('exploratory'), expand_context: noul(0), review_required: noul(0) }) })
  assert.equal(plan.policy.retrievalMode, 'adjacent')
})

test('high-risk policy cannot be weakened by Jev', async () => {
  const plan = await planTask({ task: 'wallet settlement mismatch', risk: 'high' }, { env: jevEnv, store:new AccountingStore(), fetchImpl: jevFetch({ worker: choice('scout'), context_profile: choice('tight'), retrieval_mode: choice('exact'), expand_context: noul(0), review_required: noul(0) }) })
  assert.equal(plan.route.role, 'deep_debugger')
  assert.equal(plan.policy.contextProfile, 'expanded')
  assert.equal(plan.policy.retrievalMode, 'exploratory')
  assert.equal(plan.review.required, true)
})

test('review and expandContext advice remain available', async () => {
  const plan = await planTask({ task: 'fix issue', rootCause: 'known' }, { env: jevEnv, store:new AccountingStore(), fetchImpl: jevFetch({ worker: choice('engineer'), context_profile: choice('normal'), retrieval_mode: choice('adjacent'), expand_context: noul(.4), review_required: noul(.8) }) })
  assert.equal(plan.advice.expandContext.probability, .4)
  assert.equal(plan.advice.reviewRequired.probability, .8)
  assert.equal(plan.review.recommended, true)
})

test('oversized estimated input is blocked before provider invocation', async () => {
  let calls = 0
  clearProviders()
  registerProvider('mock-preflight', { execute: async () => { calls++; throw new Error('must not execute') } })
  const result = await executeDelegation({ delegation: { role: 'engineer', context: { task: 'x', evidence: ['a'.repeat(10000)] }, instruction: 'work' }, provider: 'mock-preflight', model: 'mock', budget: { maxEstimatedInputTokens: 100 } })
  assert.equal(result.executed, false)
  assert.equal(result.reason, 'estimated-input-too-large')
  assert.equal(calls, 0)
})

test('successful provider execution records actual post-call usage', async () => {
  clearProviders()
  registerProvider('mock-usage', { execute: async query => normalizeResult({ provider: 'mock-usage', model: query.model, role: query.role, output: 'ok', usage: { inputTokens: 17, outputTokens: 4 }, metadata:{toolCalls:[{name:'report_result',arguments:JSON.stringify({status:'complete',findings:[],artifact:'ok',evidence:[],tests:[],blockers:[]})}]} }) })
  const result = await executeDelegation({ delegation: { role: 'engineer', context: { task: 'bounded' }, instruction: 'work' }, provider: 'mock-usage', model: 'mock', store:new AccountingStore(), budget: { maxEstimatedInputTokens: 1000 } })
  assert.equal(result.executed, true)
  assert.equal(result.state.inputTokens, 17)
  assert.equal(result.state.outputTokens, 4)
})
