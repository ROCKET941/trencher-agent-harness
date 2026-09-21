import routing from '../../config/routing.json' with { type: 'json' }
const TRUNCATION = '\n...[truncated]...\n'
const SECRET_MATERIAL = /(-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+\/-]+=*|\bsk-[A-Za-z0-9_-]{12,}|\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+)/i
const safePath = value => { const item=String(value||'').replaceAll('\\','/'); return Boolean(item)&&!item.startsWith('/')&&!/^[a-z]:/i.test(item)&&!item.split('/').includes('..')&&!/(^|\/)(\.env|\.git|secrets?)(\/|$)/i.test(item) }
const safeText = value => !SECRET_MATERIAL.test(String(value ?? ''))

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
  const removed=[]
  const screened=(key,value)=>Array.isArray(value)?value.filter((item,index)=>{const allowed=safeText(item);if(!allowed)removed.push(`${key}[${index}]:secret-like`);return allowed}):[]
  const screenedPaths=(key,value)=>screened(key,value).filter((item,index)=>{const allowed=safePath(item);if(!allowed)removed.push(`${key}[${index}]:unsafe-path`);return allowed})
  const task=safeText(input.task)?input.task:'[removed: secret-like task content]'
  if(task!==input.task)removed.push('task:secret-like')
  // A screened root cause must remain unknown to routing policy. A truthy
  // redaction placeholder would incorrectly suppress high-risk investigation.
  const rootCause=input.rootCause==null?null:(safeText(input.rootCause)?input.rootCause:null)
  if(input.rootCause!=null&&rootCause!==input.rootCause)removed.push('rootCause:secret-like')
  const safeFacts=Array.isArray(input.facts)?input.facts.filter((item,index)=>{const allowed=safeText(item?.claim)&&safeText(item?.source);if(!allowed)removed.push(`facts[${index}]:secret-like`);return allowed}):[]
  const safeInspected=Array.isArray(input.inspected)?input.inspected.filter((item,index)=>{const allowed=safePath(item?.path)&&safeText(item?.range)&&safeText(item?.digest);if(!allowed)removed.push(`inspected[${index}]:unsafe-or-secret-like`);return allowed}):[]
  const packet = {
    task: compactText(task, SIZES.task), risk: input.risk || 'normal',
    evidence: strings(screened('evidence',input.evidence), limits.evidence, SIZES.evidence),
    rootCause: rootCause == null ? null : compactText(rootCause, SIZES.rootCause),
    files: strings(screenedPaths('files',input.files), limits.files, SIZES.file), tests: strings(screened('tests',input.tests), limits.tests, SIZES.test),
    docs: strings(screened('docs',input.docs), limits.docs, SIZES.doc),
    protectedBoundaries: strings(screened('protectedBoundaries',input.protectedBoundaries), 12, SIZES.protectedBoundary),
    openQuestions: strings(screened('openQuestions',input.openQuestions), limits.openQuestions, SIZES.openQuestion),
    facts: facts(safeFacts, limits.facts), inspected: inspected(safeInspected, limits.inspected), contextProfile
  }
  const countLimits={evidence:limits.evidence,files:limits.files,tests:limits.tests,docs:limits.docs,openQuestions:limits.openQuestions,facts:limits.facts,inspected:limits.inspected}
  const dropped=Object.fromEntries(Object.entries(countLimits).map(([key,limit])=>[key,Math.max(0,(Array.isArray(input[key])?input[key].length:0)-limit)]).filter(([,count])=>count>0))
  const truncatedFields=[]
  if(packet.task.includes('[truncated]'))truncatedFields.push('task')
  for(const key of ['evidence','files','tests','docs','openQuestions'])packet[key].forEach((value,index)=>{if(value.includes('[truncated]'))truncatedFields.push(`${key}[${index}]`)})
  packet.truncation={occurred:Object.keys(dropped).length>0||truncatedFields.length>0||removed.length>0,dropped,truncatedFields,removed}
  return packet
}
