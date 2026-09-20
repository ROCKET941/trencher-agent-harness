import { createEvidencePacket } from '../context/evidencePacket.js'

const ALLOWED = new Set(['evidence', 'files', 'tests', 'docs', 'facts', 'inspected'])
const SECRET_MATERIAL = /(-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+\/-]+=*|\bsk-[A-Za-z0-9_-]{12,}|\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+)/i

export function safeRelativePath(value) {
  const item = String(value || '').replaceAll('\\', '/')
  return Boolean(item) && !item.startsWith('/') && !/^[a-z]:/i.test(item) &&
    !item.split('/').includes('..') && !/(^|\/)(\.env|\.git|secrets?)(\/|$)/i.test(item)
}

function allStrings(value, output = []) {
  if (typeof value === 'string') output.push(value)
  else if (Array.isArray(value)) for (const item of value) allStrings(item, output)
  else if (value && typeof value === 'object') for (const item of Object.values(value)) allStrings(item, output)
  return output
}

export function normalizeApprovedEvidence(input = {}, task = '', risk = 'normal') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { allowed: false, reason: 'approved-evidence-invalid' }
  const unexpected = Object.keys(input).filter(key => !ALLOWED.has(key))
  if (unexpected.length) return { allowed: false, reason: 'approved-evidence-fields-not-allowed', fields: unexpected }
  if (allStrings(input).some(value => SECRET_MATERIAL.test(value))) return { allowed: false, reason: 'approved-evidence-secret-like' }
  for (const value of input.files || []) if (!safeRelativePath(value)) return { allowed: false, reason: 'approved-evidence-unsafe-path' }
  for (const value of input.inspected || []) if (!safeRelativePath(value?.path)) return { allowed: false, reason: 'approved-evidence-unsafe-path' }
  const hasEvidence = ['evidence', 'files', 'tests', 'docs', 'facts', 'inspected'].some(key => Array.isArray(input[key]) && input[key].length > 0)
  if (!hasEvidence) return { allowed: false, reason: 'approved-evidence-required' }
  const packet = createEvidencePacket({ task, risk, ...input })
  const evidence = Object.fromEntries([...ALLOWED].map(key => [key, packet[key]]))
  return { allowed: true, evidence, truncation: packet.truncation }
}
