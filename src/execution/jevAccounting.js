export const JEV_INPUT_USD_PER_MILLION = 0.042

const tokenCount = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null

export function reconcileJevUsage(rawUsage, reservedCostUsd, { priorUncertainBilling = false, inputUsdPerMillion = JEV_INPUT_USD_PER_MILLION } = {}) {
  const inputTokens = tokenCount(rawUsage?.input_tokens ?? rawUsage?.inputTokens)
  const outputTokens = tokenCount(rawUsage?.output_tokens ?? rawUsage?.outputTokens)
  const configuredRate = Number(inputUsdPerMillion)
  const rate = Number.isFinite(configuredRate) && configuredRate > 0 ? configuredRate : JEV_INPUT_USD_PER_MILLION
  const measuredCost = inputTokens === null ? null : inputTokens * rate / 1_000_000
  const measured = measuredCost !== null && !priorUncertainBilling
  return {
    usage: inputTokens === null ? null : { inputTokens, outputTokens: outputTokens ?? 0 },
    actualCostUsd: measured ? measuredCost : Math.max(reservedCostUsd, measuredCost ?? 0),
    costBasis: measured ? 'reported-input-usage' : 'conservative-reservation'
  }
}
