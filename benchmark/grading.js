export function summarize(allChecks) {
  const groups = {}
  for (const item of allChecks) {
    const group = groups[item.category] ||= { earned: 0, possible: 0, passed: 0, checks: 0 }
    group.possible += item.points
    group.checks += 1
    if (item.passed) { group.earned += item.points; group.passed += 1 }
  }
  for (const group of Object.values(groups)) group.score = group.possible ? Math.round(group.earned / group.possible * 1000) / 10 : 0
  const earned = allChecks.reduce((sum, item) => sum + (item.passed ? item.points : 0), 0)
  const possible = allChecks.reduce((sum, item) => sum + item.points, 0)
  return { earned, possible, score: possible ? Math.round(earned / possible * 1000) / 10 : 0, groups }
}

export function boundedAt(value, limit, ranks) { return Object.hasOwn(ranks, value) && ranks[value] <= ranks[limit] }
export function atLeast(value, limit, ranks) { return Object.hasOwn(ranks, value) && ranks[value] >= ranks[limit] }

export function answerArtifact(structured) {
  const raw = String(structured?.artifact || '').trim()
  const candidate = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    const parsed = JSON.parse(candidate)
    if (parsed && typeof parsed.artifact === 'string') return parsed.artifact
  } catch {}
  return raw
}

export function gradeProviderTask(kind, structured) {
  const artifact = answerArtifact(structured)
  const compact = artifact.replace(/\s+/g, '')
  if (kind === 'clamp_patch') {
    const correct = compact.includes('Math.min(max,Math.max(min,n))') || compact.includes('Math.max(min,Math.min(max,n))')
    const lines = artifact.split(/\r?\n/)
    const removed = lines.filter(line => /^-(?!-{2})/.test(line))
    const added = lines.filter(line => /^\+(?!\+{2})/.test(line))
    const paths = lines.filter(line => /^(?:---|\+\+\+)\s/.test(line))
    const scope = paths.length === 2 && paths.every(line => /^(?:--- a|\+\+\+ b)\/src\/clamp\.js$/.test(line.trim()))
    const oneLineChange = removed.length === 1 && added.length === 1 && removed[0].includes('Math.min(min, Math.max(max, n))') && correct
    return { correct, detail: { correctFormula: correct, boundedPatchScope: scope, oneLineChange }, all: correct && scope && oneLineChange }
  }
  if (kind === 'caller_map') {
    const required = ['src/orders/finalize.ts:18', 'src/retry/replay.ts:42']
    const forbidden = ['src/swap/reconcile.ts:7', 'src/docs/flow.ts:9', 'test/reconcile.test.ts:21', 'src/metrics/names.ts:4']
    const correct = required.every(value => artifact.includes(value)) && forbidden.every(value => !artifact.includes(value))
    return { correct, detail: { required: Object.fromEntries(required.map(value => [value, artifact.includes(value)])), forbidden: Object.fromEntries(forbidden.map(value => [value, artifact.includes(value)])) }, all: correct }
  }
  if (kind === 'async_root_cause') {
    const lower = artifact.replaceAll('\\n', '\n').toLowerCase()
    const missingAwait = lower.includes('await') && lower.includes('flushqueue')
    const added = lower.split(/\r?\n/).filter(line => /^\+(?!\+\+)/.test(line)).join('\n')
    const orderedText = added || lower
    const awaitIndex = orderedText.indexOf('await flushqueue')
    const closeIndexes = [orderedText.indexOf('closedatabase'), orderedText.indexOf('db.close')].filter(index => index >= 0)
    const codeOrdering = awaitIndex >= 0 && closeIndexes.some(index => awaitIndex < index)
    const closesAfterAwait = (lower.includes('close') || lower.includes('database')) && (lower.includes('before') || lower.includes('then') || codeOrdering)
    const correct = missingAwait && closesAfterAwait
    return { correct, detail: { missingAwait, ordering: closesAfterAwait }, all: correct }
  }
  return { correct: false, detail: { unknownKind: kind }, all: false }
}
