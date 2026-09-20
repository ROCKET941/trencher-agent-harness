const BASE = 'https://api.typesafe.ai', RETRYABLE = new Set([429, 529])
const CONTEXT_PROFILES = new Set(['tight', 'normal', 'expanded'])
const RETRIEVAL_MODES = new Set(['exact', 'adjacent', 'exploratory'])
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const number = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback
export const jevConfigured = (env = process.env) => Boolean(env.TYPESAFE_API_KEY)
export const normalizeChoice = answer => answer?.type === 'choice'
  ? { choice: answer.choice, probabilities: answer.probabilities || {}, confidence: number(answer.confidence, 0) } : null
export const normalizeNoul = answer => answer?.type === 'noul' ? { probability: number(answer.noul, 0) } : null
export const normalizeContextProfile = answer => { const value = normalizeChoice(answer); return value && CONTEXT_PROFILES.has(value.choice) ? value : null }
export const normalizeRetrievalMode = answer => { const value = normalizeChoice(answer); return value && RETRIEVAL_MODES.has(value.choice) ? value : null }
function delay(response, attempt) { const seconds = Number(response.headers?.get?.('retry-after')); return Number.isFinite(seconds) ? seconds * 1000 : Math.min(2000, 250 * (2 ** attempt)) }

export async function askJev({ state, questions }, options = {}) {
  const env = options.env || process.env
  if (!jevConfigured(env)) return { available: false, reason: 'jev-not-configured' }
  const fetchImpl = options.fetchImpl || globalThis.fetch, timeout = number(env.TYPESAFE_TIMEOUT_MS, 5000), maxRetries = options.maxRetries ?? 2
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout)
    try {
      const response = await fetchImpl(`${BASE}/v1/systemone`, { method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${env.TYPESAFE_API_KEY}` },
        body: JSON.stringify({ model: env.TYPESAFE_MODEL || 'jev-latest', state, questions }) })
      if (RETRYABLE.has(response.status) && attempt < maxRetries) { clearTimeout(timer); await sleep(delay(response, attempt)); continue }
      if (!response.ok) return { available: false, reason: `jev-http-${response.status}`, retries: attempt }
      const raw = await response.json()
      return { available: true, reason: 'jev', model: raw.model, answers: raw.answers || {}, usage: raw.usage || {}, retries: attempt }
    } catch (error) {
      if (attempt < maxRetries && (error?.name === 'AbortError' || error instanceof TypeError)) { clearTimeout(timer); await sleep(250 * (2 ** attempt)); continue }
      return { available: false, reason: error?.name === 'AbortError' ? 'jev-timeout' : 'jev-network-error', retries: attempt }
    } finally { clearTimeout(timer) }
  }
}

export async function askRoutingJev(packet, options = {}) {
  const result = await askJev({ state: { task: packet.task, risk: packet.risk, root_cause_known: Boolean(packet.rootCause), evidence: packet.evidence, files: packet.files, open_questions: packet.openQuestions, facts: packet.facts, inspected: packet.inspected }, questions: {
    worker: { type: 'choice', instructions: 'Choose the cheapest capable worker. Never downgrade high-risk unknown-root-cause work.', criteria: { scout: 'Repository search and reconnaissance only.', engineer: 'Bounded implementation with an established causal path.', deep_debugger: 'Ambiguous high-risk root cause, financial correctness, concurrency, distributed state or execution.' } },
    context_profile: { type: 'choice', instructions: 'Choose the smallest sufficient bounded context. Expanded requires concrete missing evidence, ambiguity, or high risk.', criteria: { tight: 'Localized work with strong symbol, file, or exact-search evidence.', normal: 'Ordinary bounded engineering using direct dependencies.', expanded: 'Current evidence is insufficient for genuinely ambiguous or high-risk work.' } },
    retrieval_mode: { type: 'choice', instructions: 'Choose the narrowest sufficient repository retrieval scope. Exploratory is exceptional.', criteria: { exact: 'Known symbols, exact hits, named files, and relevant excerpts only.', adjacent: 'Direct callers, callees, imports, and dependencies around known evidence.', exploratory: 'Broader investigation because root cause or context is genuinely unknown.' } },
    expand_context: { type: 'noul', instructions: 'Is more repository context required?', criteria: { true: 'More evidence is necessary.', false: 'Current evidence is sufficient.' } },
    review_required: { type: 'noul', instructions: 'Should this change receive an independent bounded review?', criteria: { true: 'Meaningful normal/high-risk change.', false: 'Trivial low-risk work.' } }
  } }, options)
  return result.available ? { ...result, worker: normalizeChoice(result.answers.worker), contextProfile: normalizeContextProfile(result.answers.context_profile), retrievalMode: normalizeRetrievalMode(result.answers.retrieval_mode), expandContext: normalizeNoul(result.answers.expand_context), reviewRequired: normalizeNoul(result.answers.review_required) } : result
}
