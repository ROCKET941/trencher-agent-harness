import routing from '../../config/routing.json' with { type: 'json' }
const positiveInt = (value, fallback) => Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback
export function resolveBudget(input = {}, env = process.env) {
  const ceilingInput = positiveInt(env.HARNESS_MAX_INPUT_TOKENS, routing.limits.maxEstimatedInputTokens || 12000)
  const maxInputTokens = Math.min(positiveInt(input.maxInputTokens, ceilingInput),ceilingInput)
  const ceilingEstimated=positiveInt(env.HARNESS_MAX_ESTIMATED_INPUT_TOKENS,ceilingInput)
  const ceilingOutput=positiveInt(env.HARNESS_MAX_OUTPUT_TOKENS,5000)
  return {
    maxInputTokens,
    maxEstimatedInputTokens: Math.min(positiveInt(input.maxEstimatedInputTokens,ceilingEstimated),ceilingEstimated,maxInputTokens),
    maxOutputTokens: Math.min(positiveInt(input.maxOutputTokens,ceilingOutput),ceilingOutput),
    maxDelegations: positiveInt(env.HARNESS_MAX_DELEGATIONS,2),
    maxParallel: Math.min(routing.limits.hardMaxParallel,positiveInt(env.HARNESS_MAX_PARALLEL,routing.limits.maxParallel)),
    maxAttempts: Math.min(routing.limits.maxAttempts,positiveInt(env.HARNESS_MAX_ATTEMPTS,routing.limits.maxAttempts))
  }
}
export function checkExecutionBudget(state = {}, budget = resolveBudget()) {
  const reasons = []
  if ((state.inputTokens || 0) >= budget.maxInputTokens) reasons.push('input-token-budget')
  if ((state.outputTokens || 0) >= budget.maxOutputTokens) reasons.push('output-token-budget')
  if ((state.delegations || 0) >= budget.maxDelegations) reasons.push('delegation-budget')
  if ((state.active || 0) >= budget.maxParallel) reasons.push('parallel-budget')
  if ((state.attempts || 0) >= budget.maxAttempts) reasons.push('attempt-budget')
  return { allowed: !reasons.length, reasons }
}
export function estimateInputTokens(value) { return Math.ceil(Buffer.byteLength(JSON.stringify(value), 'utf8') / 3) }
export function checkEstimatedInput(value, budget = resolveBudget()) {
  const estimatedInputTokens = estimateInputTokens(value)
  return { allowed: estimatedInputTokens <= budget.maxEstimatedInputTokens, estimatedInputTokens, limit: budget.maxEstimatedInputTokens, reason: estimatedInputTokens <= budget.maxEstimatedInputTokens ? null : 'estimated-input-too-large' }
}
