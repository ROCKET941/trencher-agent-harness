export function nextAttemptState({attempts=[],newEvidence=false,ownerAuthorizedRetry=false,retryReason=''}){
  const count=Array.isArray(attempts)?attempts.length:0
  if(count>=3)return{action:'stop_escalate',allowed:false,reason:'owner-authorized-retry-limit'}
  if(count===2){
    if(!ownerAuthorizedRetry)return{action:'request_owner_authorization',allowed:false,reason:'third-attempt-requires-owner-authorization'}
    if(!newEvidence||!String(retryReason).trim())return{action:'gather_evidence',allowed:false,reason:'owner-authorized-retry-requires-new-causal-evidence'}
    return{action:'implement',allowed:true,reason:'owner-authorized-final-attempt',finalAttempt:true}
  }
  if(count===1&&!newEvidence)return{action:'gather_evidence',allowed:false,reason:'second-attempt-requires-new-evidence'}
  return{action:'implement',allowed:true,reason:count?'new-evidence':'first-attempt',finalAttempt:false}
}
