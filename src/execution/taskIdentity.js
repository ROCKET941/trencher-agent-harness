import { createHash } from 'node:crypto'

const digest = value => createHash('sha256').update(String(value)).digest('hex')

export function taskIdentityFromContext(context = {}) {
  return digest(JSON.stringify({
    task: String(context.task || '').trim()
  })).slice(0, 32)
}

export const digestValue = value => digest(JSON.stringify(value))
