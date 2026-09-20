import { getProvider } from '../providers/registry-v12.js'
import { resolveBudget, checkExecutionBudget, checkEstimatedInput } from '../budget/executionBudget.js'
export async function executeDelegation({ delegation, provider, model, budget: asked, state = {}, env = process.env }) {
  const budget = resolveBudget(asked, env)
  const gate = checkExecutionBudget(state, budget)
  if (!gate.allowed) return { executed: false, reason: 'budget-blocked', gate, state }
  const request = { role: delegation.role, task: delegation.context?.task || '', context: delegation.context || {}, instruction: delegation.instruction || '', provider, model, budget }
  const adapter = getProvider(provider)
  const estimatedPayload = typeof adapter.prepare === 'function' ? adapter.prepare(request) : request
  const remainingActualBudget = Math.max(0, budget.maxInputTokens - (state.inputTokens || 0))
  const preflight = checkEstimatedInput(estimatedPayload, { ...budget, maxEstimatedInputTokens: Math.min(budget.maxEstimatedInputTokens, remainingActualBudget) })
  if (!preflight.allowed) return { executed: false, reason: 'estimated-input-too-large', preflight, state }
  const result = await adapter.execute(request)
  return { executed: true, result, preflight, state: { ...state, active: 0, inputTokens: (state.inputTokens || 0) + result.usage.inputTokens, outputTokens: (state.outputTokens || 0) + result.usage.outputTokens, delegations: (state.delegations || 0) + 1 } }
}
