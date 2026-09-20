import { listModels, providerConfig, resolveProviderKey } from './catalog.js'

export async function getProviderStatus(provider,{env=process.env,fetchImpl=globalThis.fetch,refresh=false}={}){
  const cfg=providerConfig(provider),keyInfo=resolveProviderKey(provider,env),canonical=listModels({provider}).map(model=>model.id)
  if(!keyInfo.key)return{provider,configured:false,reachable:null,keyEnv:null,canonical,visible:[],eligible:[],reason:'provider-key-not-configured'}
  if(!refresh)return{provider,configured:true,reachable:null,keyEnv:keyInfo.keyEnv,canonical,visible:[],eligible:canonical,reason:'catalog-not-refreshed'}
  const base=(env[cfg.baseUrlEnv]||cfg.defaultBaseUrl).replace(/\/$/,'')
  try{const response=await fetchImpl(`${base}${cfg.catalogPath}`,{headers:{authorization:`Bearer ${keyInfo.key}`}});if(!response.ok)return{provider,configured:true,reachable:false,keyEnv:keyInfo.keyEnv,canonical,visible:[],eligible:[],reason:`catalog-http-${response.status}`};const value=await response.json(),visible=(value.data||value.models||[]).map(item=>typeof item==='string'?item:item.id).filter(Boolean);return{provider,configured:true,reachable:true,keyEnv:keyInfo.keyEnv,canonical,visible,eligible:canonical.filter(id=>visible.includes(id)),reason:'account-catalog-verified'}}catch{return{provider,configured:true,reachable:false,keyEnv:keyInfo.keyEnv,canonical,visible:[],eligible:[],reason:'catalog-network-error'}}
}
