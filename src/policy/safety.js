const PROTECTED = new Set(['deploy','force_push','delete_branch','wallet_permission_change','financial_execution','secret_read','retry_budget_override'])
export function authorizeAction(action,{explicitlyAuthorized=false}={}){if(!PROTECTED.has(action))return{allowed:true,reason:'not-protected'};if(explicitlyAuthorized&&action!=='retry_budget_override')return{allowed:true,reason:'explicitly-authorized'};return{allowed:false,reason:'protected-action-requires-explicit-authorization'}}
export function isProtectedAction(action){return PROTECTED.has(action)}
