import test from 'node:test'
import assert from 'node:assert/strict'
import {
  routeTask, buildEvidencePacket, checkContinue, checkAction,
  createDelegationRequest, reviewRoute
} from '../src/mcp/tools.js'

test('route_task selects scout for retrieval', async () => {
  const result = await routeTask({ task: 'Find callers of reconcileSwapFill' }, { useJev: false })
  assert.equal(result.route.role, 'scout')
})

test('build_evidence_packet enforces context bounds', () => {
  const files = Array.from({ length: 10 }, (_, i) => `f${i}.js`)
  const { packet } = buildEvidencePacket({ task: 'x', files })
  assert.equal(packet.files.length, 6)
})

test('check_continue blocks a second attempt without evidence', () => {
  assert.equal(checkContinue({ attempts: [{}], newEvidence: false }).allowed, false)
})

test('check_action blocks deployment without authorization', () => {
  assert.equal(checkAction({ action: 'deploy' }).allowed, false)
})

test('create_delegation is provider neutral', () => {
  const result = createDelegationRequest({ role: 'engineer', packet: { task: 'implement' } })
  assert.equal(result.role, 'engineer')
  assert.equal(result.agent.preferredFamily, 'astra')
})

test('review_route always produces reviewer role', async () => {
  const result = await reviewRoute({ task: 'review diff' })
  assert.equal(result.route.role, 'reviewer')
})
