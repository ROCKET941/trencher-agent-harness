import { ProviderAdapter, normalizeResult } from './base.js'

function responseBody(query) {
  return {
    model: query.model,
    input: [
      { role: 'developer', content: [{ type: 'input_text', text: query.instruction || 'Complete the bounded delegated task.' }] },
      { role: 'user', content: [{ type: 'input_text', text: JSON.stringify({ task: query.task, context: query.context }) }] }
    ],
    max_output_tokens: query.budget.maxOutputTokens
  }
}

export class OpenAIProvider extends ProviderAdapter {
  constructor({ env = process.env, fetchImpl = globalThis.fetch } = {}) { super('openai'); this.env = env; this.fetch = fetchImpl }
  prepare(query) { return responseBody(query) }
  async execute(query) {
    const key = this.env.OPENAI_API_KEY
    if (!key) throw new Error('OPENAI_API_KEY not configured')
    if (!query.model) throw new Error(`No model configured for ${query.role}`)
    const base = (this.env.OPENAI_BASE_URL || 'https://api.openai.com').replace(/\/$/, '')
    const response = await this.fetch(`${base}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(responseBody(query)) })
    if (!response.ok) throw new Error(`openai-http-${response.status}`)
    const value = await response.json()
    const output = value.output_text ?? (value.output || []).flatMap(item => item.content || []).filter(item => item.type === 'output_text').map(item => item.text).join('\n')
    return normalizeResult({ provider: 'openai', model: query.model, role: query.role, output, usage: { inputTokens: value.usage?.input_tokens, outputTokens: value.usage?.output_tokens, totalTokens: value.usage?.total_tokens }, finishReason: value.status, metadata: { responseId: value.id } })
  }
}
