import { listModels, providerConfig, resolveProviderKey } from './catalog.js'
import { executionModeForProvider } from '../policy/providerExecution.js'

export async function getProviderStatus(provider,{env=process.env,fetchImpl=globalThis.fetch,refresh=false}={}){
  const executionMode=executionModeForProvider(provider),cfg=providerConfig(provider),canonical=listModels({provider}).map(model=>model.id)
  if(executionMode==='native_host')return{provider,executionMode,configured:false,reachable:null,keyEnv:null,canonical,visible:[],eligible:canonical,reason:'native-host-managed-no-api-key-required'}
  const keyInfo=resolveProviderKey(provider,env)
  if(!keyInfo.key)return{provider,executionMode,configured:false,reachable:null,keyEnv:null,canonical,visible:[],eligible:[],reason:'provider-key-not-configured'}
  if(!refresh)return{provider,executionMode,configured:true,reachable:null,keyEnv:keyInfo.keyEnv,canonical,visible:[],eligible:canonical,reason:'catalog-not-refreshed'}
  const base=(env[cfg.baseUrlEnv]||cfg.defaultBaseUrl).replace(/\/$/,'')
  try{const response=await fetchImpl(`${base}${cfg.catalogPath}`,{headers:{authorization:`Bearer ${keyInfo.key}`}});if(!response.ok)return{provider,executionMode,configured:true,reachable:false,keyEnv:keyInfo.keyEnv,canonical,visible:[],eligible:[],reason:`catalog-http-${response.status}`};const value=await response.json(),visible=(value.data||value.models||[]).map(item=>typeof item==='string'?item:item.id).filter(Boolean);return{provider,executionMode,configured:true,reachable:true,keyEnv:keyInfo.keyEnv,canonical,visible,eligible:canonical.filter(id=>visible.includes(id)),reason:'account-catalog-verified'}}catch{return{provider,executionMode,configured:true,reachable:false,keyEnv:keyInfo.keyEnv,canonical,visible:[],eligible:[],reason:'catalog-network-error'}}
}
