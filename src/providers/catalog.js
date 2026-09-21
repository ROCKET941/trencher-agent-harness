import config from '../../config/providers.json' with { type: 'json' }
import { executionModeForProvider } from '../policy/providerExecution.js'

export const REGISTRY_VERSION = config.version
const verifiedAt = '2026-09-20'
const models = [
  ['openai', 'gpt-5.6-luna', ['max'], null, null, null, 'https://developers.openai.com/api/docs/models'],
  ['openai', 'gpt-6-astra', ['xhigh'], null, null, null, 'https://developers.openai.com/api/docs/models'],
  ['xai', 'grok-4.6', ['low','medium','high','xhigh'], 2, 6, null, 'https://docs.x.ai/developers/models'],
  ['deepseek', 'deepseek-flash', ['none','low','high','max'], 0.30, 1.20, 1000000, 'https://api-docs.deepseek.com/quick_start/pricing'],
  ['deepseek', 'deepseek-v4-pro', ['none','low','high','max'], 1.32, 3.96, 1000000, 'https://api-docs.deepseek.com/quick_start/pricing'],
  ['kimi', 'kimi-k3', ['low','high','max'], 3, 15, 1000000, 'https://www.kimi.ai/help/kimi-api/api-overview']
].map(([provider,id,efforts,inputPerMTok,outputPerMTok,contextTokens,source]) => ({
  provider,id,efforts,inputPerMTok,outputPerMTok,contextTokens,source,verifiedAt,executionMode:executionModeForProvider(provider),
  transport: provider === 'kimi' || provider === 'deepseek' ? 'chat_completions' : 'responses',
  alwaysThinking: provider === 'kimi'
}))

const byKey = new Map(models.map(model => [`${model.provider}:${model.id}`, model]))
const capabilityRank=new Map([['openai:gpt-5.6-luna',0],['openai:gpt-6-astra',3],['xai:grok-4.6',2],['deepseek:deepseek-flash',1],['deepseek:deepseek-v4-pro',2],['kimi:kimi-k3',2]])
const roleRank={scout:0,engineer:0,deep_debugger:2,reviewer:2,exceptional:3}
export const listModels = ({ provider } = {}) => models.filter(model => !provider || model.provider === provider).map(model => structuredClone(model))
export function getModel(provider, model) { const value=byKey.get(`${provider}:${model}`); return value ? structuredClone(value) : null }
export function validateModel({ provider, model, effort }) {
  const entry = getModel(provider, model)
  if (!entry) return { allowed:false, reason:'model-not-in-verified-registry', provider, model }
  if (!entry.efforts.includes(effort)) return { allowed:false, reason:'unsupported-reasoning-effort', provider, model, effort, allowedEfforts:entry.efforts }
  return { allowed:true, entry }
}
export function eligibleForRole(role,entry){
  if(role==='scout')return entry.provider==='openai'&&entry.id==='gpt-5.6-luna'
  if(entry.provider==='openai')return entry.id==='gpt-6-astra'&&Object.hasOwn(roleRank,role)
  if(role==='reviewer')return false // Final acceptance belongs to one fresh native Astra.
  return(capabilityRank.get(`${entry.provider}:${entry.id}`)??-1)>=(roleRank[role]??99)
}
export const modelCapability = entry => capabilityRank.get(`${entry.provider}:${entry.id}`) ?? -1
export function estimateCostUsd(entry, inputTokens, outputTokens) {
  if (!Number.isFinite(entry?.inputPerMTok) || !Number.isFinite(entry?.outputPerMTok)) return null
  return (Number(inputTokens || 0) * entry.inputPerMTok + Number(outputTokens || 0) * entry.outputPerMTok) / 1_000_000
}
export function providerConfig(provider) { const value=config.providers[provider]; if(!value) throw new Error(`Unknown provider: ${provider}`); return structuredClone(value) }
export function resolveProviderKey(provider, env=process.env) { const cfg=providerConfig(provider); for(const name of cfg.keyEnv){if(env[name])return{key:env[name],keyEnv:name}} return{key:'',keyEnv:null} }
export function modelCatalogSummary() { return { version:REGISTRY_VERSION, verifiedAt, models:listModels() } }
