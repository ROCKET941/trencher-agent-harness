import assert from 'node:assert/strict'
import { planTask } from '../src/orchestrator.js'
import { routingModels } from '../src/router/jev.js'

// Opt-in LIVE routing only: at most two Jev requests, no provider execution.
// The normal paid gate, price bound and shared server ledger remain authoritative.
const cases = [{ name: 'workspace-lookup', input: { task: 'Find every caller of reconcileSwapFill in a large production repository. Inspect source and run the targeted tests locally; no source contents have been supplied.', risk: 'normal' } }]
if (routingModels().some(model => model.executionMode === 'external_api')) cases.push({ name: 'supplied-content-patch', input: {
  task: 'Analyze this complete isolated clamp helper and return the smallest patch plus expected test values. All relevant source is supplied; the parent will apply and test the returned patch. No repository inspection or commands are needed.',
  risk: 'normal', rootCause: 'Math.min uses the lower bound instead of the upper bound',
  evidence: ['Complete src/clamp.js: export function clamp(value, min, max) { return Math.min(min, Math.max(min, value)); }'],
  tests: ['clamp(5,0,10) must equal 5; clamp(-1,0,10) must equal 0; clamp(11,0,10) must equal 10.']
} })
for (const sample of cases) {
  const started = Date.now(), plan = await planTask(sample.input, { useCache: false, maxRetries: 0 })
  const advice = plan.advice
  assert.equal(advice?.available, true, `Jev unavailable: ${advice?.reason}`)
  assert.ok(advice.executionLane, 'Missing typed execution lane')
  console.log(JSON.stringify({ sample: sample.name, model: advice.model, lane: advice.executionLane, target: advice.target, effort: advice.effort, effective: plan.routingDecision.effective, selection: plan.routingDecision.selection.target, usage: advice.usage, costUsd: advice.job?.actualCostUsd, latencyMs: Date.now() - started }, null, 2))
}
