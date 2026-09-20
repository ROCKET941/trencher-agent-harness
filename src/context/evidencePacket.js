import routing from '../../config/routing.json' with { type: 'json' }
const TRUNCATION = '\n...[truncated]...\n'

export const CONTEXT_PROFILES = Object.freeze(routing.limits.contextProfiles)

const SIZES = Object.freeze({ task: 4000, evidence: 3000, file: 5000, test: 2500, doc: 3000,
  protectedBoundary: 500, openQuestion: 1000, rootCause: 3000, factClaim: 1000,
  factSource: 500, inspectedPath: 1000, inspectedRange: 100, inspectedDigest: 200 })

export function compactText(value, maxLength) {
  const text = String(value ?? '').trim()
  if (text.length <= maxLength) return text
  const remaining = maxLength - TRUNCATION.length
  const head = Math.ceil(remaining * 0.7)
  const tail = Math.max(0, remaining - head)
  return `${text.slice(0, head)}${TRUNCATION}${tail ? text.slice(-tail) : ''}`
}

const strings = (value, count, size) => Array.isArray(value)
  ? value.slice(0, count).map(item => compactText(item, size)) : []
const facts = (value, count) => Array.isArray(value) ? value.slice(0, count).map(item => ({
  claim: compactText(item?.claim, SIZES.factClaim), source: compactText(item?.source, SIZES.factSource)
})).filter(item => item.claim) : []
const inspected = (value, count) => Array.isArray(value) ? value.slice(0, count).map(item => ({
  path: compactText(item?.path, SIZES.inspectedPath), range: compactText(item?.range, SIZES.inspectedRange),
  digest: compactText(item?.digest, SIZES.inspectedDigest)
})).filter(item => item.path) : []

export function normalizeContextProfile(profile) {
  return Object.hasOwn(CONTEXT_PROFILES, profile) ? profile : 'normal'
}

export function createEvidencePacket(input = {}, options = {}) {
  const contextProfile = normalizeContextProfile(options.contextProfile || input.contextProfile)
  const limits = CONTEXT_PROFILES[contextProfile]
  return {
    task: compactText(input.task, SIZES.task), risk: input.risk || 'normal',
    evidence: strings(input.evidence, limits.evidence, SIZES.evidence),
    rootCause: input.rootCause == null ? null : compactText(input.rootCause, SIZES.rootCause),
    files: strings(input.files, limits.files, SIZES.file), tests: strings(input.tests, limits.tests, SIZES.test),
    docs: strings(input.docs, limits.docs, SIZES.doc),
    protectedBoundaries: strings(input.protectedBoundaries, 12, SIZES.protectedBoundary),
    openQuestions: strings(input.openQuestions, limits.openQuestions, SIZES.openQuestion),
    facts: facts(input.facts, limits.facts), inspected: inspected(input.inspected, limits.inspected), contextProfile
  }
}
