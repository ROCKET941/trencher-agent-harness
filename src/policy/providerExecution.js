const NATIVE_HOST_PROVIDERS = new Set(['openai'])
const EXTERNAL_API_PROVIDERS = new Set(['xai', 'deepseek', 'kimi'])

export function executionModeForProvider(provider) {
  if (NATIVE_HOST_PROVIDERS.has(provider)) return 'native_host'
  if (EXTERNAL_API_PROVIDERS.has(provider)) return 'external_api'
  return 'local_adapter'
}

export function providerExecutionPolicy(provider) {
  const executionMode = executionModeForProvider(provider)
  if (executionMode === 'native_host') {
    return {
      allowed: false,
      executionMode,
      reason: 'native-host-agent-required',
      billingSource: 'chatgpt_plan'
    }
  }
  return {
    allowed: true,
    executionMode,
    reason: executionMode === 'external_api' ? 'external-api-provider' : 'local-adapter',
    billingSource: executionMode === 'external_api' ? 'provider_api' : 'local'
  }
}
