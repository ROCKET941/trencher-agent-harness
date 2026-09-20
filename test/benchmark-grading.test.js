import test from 'node:test'
import assert from 'node:assert/strict'
import { answerArtifact, gradeProviderTask, summarize } from '../benchmark/grading.js'
import { verifyClampPatch } from '../benchmark/git-fixture.js'

test('benchmark grader accepts both correct clamp formulations', () => {
  for (const formula of ['Math.min(max, Math.max(min, n))', 'Math.max(min, Math.min(max, n))']) {
    const artifact = `--- a/src/clamp.js\n+++ b/src/clamp.js\n@@ -1 +1 @@\n-export function clamp(n, min, max) { return Math.min(min, Math.max(max, n)); }\n+export function clamp(n, min, max) { return ${formula}; }`
    assert.equal(gradeProviderTask('clamp_patch', { artifact }).all, true)
  }
})

test('validated clamp patch applies to an isolated git fixture and passes tests', async () => {
  const artifact = '--- a/src/clamp.js\n+++ b/src/clamp.js\n@@ -1 +1 @@\n-export function clamp(n, min, max) { return Math.min(min, Math.max(max, n)); }\n+export function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }'
  assert.deepEqual(await verifyClampPatch({ artifact }), { passed: true, stage: 'test', tests: 3 })
})

test('benchmark grader extracts an artifact from fenced fallback JSON', () => {
  const wrapped = `\`\`\`json\n${JSON.stringify({ status: 'complete', artifact: '["src/orders/finalize.ts:18", "src/retry/replay.ts:42"]' })}\n\`\`\``
  assert.equal(answerArtifact({ artifact: wrapped }), '["src/orders/finalize.ts:18", "src/retry/replay.ts:42"]')
  assert.equal(gradeProviderTask('caller_map', { artifact: wrapped }).all, true)
})

test('caller-map grader rejects definitions, comments, tests, and string hits', () => {
  const artifact = '["src/orders/finalize.ts:18", "src/retry/replay.ts:42", "src/docs/flow.ts:9"]'
  assert.equal(gradeProviderTask('caller_map', { artifact }).all, false)
})

test('async root-cause grader accepts code-order evidence without exact prose', () => {
  const artifact = '- flushQueue();\n- closeDatabase();\n+ await flushQueue();\n+ closeDatabase();'
  assert.equal(gradeProviderTask('async_root_cause', { artifact }).all, true)
  assert.equal(gradeProviderTask('async_root_cause', { artifact: artifact.replaceAll('\n', '\\n') }).all, true)
})

test('score aggregation preserves weighted categories', () => {
  const score = summarize([
    { category: 'safety', passed: true, points: 3 },
    { category: 'accuracy', passed: false, points: 1 }
  ])
  assert.deepEqual({ earned: score.earned, possible: score.possible, score: score.score }, { earned: 3, possible: 4, score: 75 })
  assert.equal(score.groups.safety.score, 100)
  assert.equal(score.groups.accuracy.score, 0)
})
